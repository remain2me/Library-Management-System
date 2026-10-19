const express = require("express");
const prisma = require("../db");
const { authenticate } = require("../middleware/authMiddleware");
const {
  HOUR_MS,
  Refuse,
  sendError,
  getNumberSetting,
  freeCopies,
  hasUnpaidFines,
  usedSlots,
  promoteQueue,
  sweepExpiredHolds,
} = require("../helpers/library");

const router = express.Router();
const SERIALIZABLE = { isolationLevel: "Serializable" };

// Everything a member must satisfy before holding a book or joining its queue.
// Returns the book. Throws Refuse with a clear message otherwise.
async function checkMemberMayTake(tx, userId, bookId) {
  const user = await tx.user.findUnique({ where: { id: userId }, include: { role: true } });
  if (!user || !user.isActive) throw new Refuse(403, "Your account is deactivated");
  if (!user.role) throw new Refuse(403, "Your account has not been verified yet");
  if (!user.role.canBorrow) throw new Refuse(403, "Your role cannot borrow or reserve books right now");

  const book = await tx.book.findUnique({ where: { id: bookId } });
  if (!book) throw new Refuse(404, "Book not found");
  if (!book.isIssuable) throw new Refuse(400, "This item cannot be issued for home use");

  if ((await usedSlots(tx, userId)) >= user.role.maxBooks)
    throw new Refuse(400, `You have used your borrowing limit (${user.role.maxBooks} books)`);
  if (await hasUnpaidFines(tx, userId)) throw new Refuse(400, "You have unpaid fines. Please clear your dues first");

  const [loan, hold, queued] = await Promise.all([
    tx.loan.count({ where: { borrowerId: userId, bookId, status: "ACTIVE" } }),
    tx.hold.count({ where: { userId, bookId, status: "ACTIVE", expiresAt: { gt: new Date() } } }),
    tx.reservation.count({ where: { userId, bookId, status: { in: ["WAITING", "READY"] } } }),
  ]);
  if (loan) throw new Refuse(400, "You already have this book");
  if (hold) throw new Refuse(400, "You already hold this book");
  if (queued) throw new Refuse(400, "You are already in the waiting queue for this book");
  return book;
}

// ---------- HOLDS (flag an available book for 24 hours) ----------

// POST /api/holds  { bookId }
router.post("/holds", authenticate, async (req, res) => {
  const bookId = Number(req.body?.bookId);
  if (!Number.isInteger(bookId)) return res.status(400).json({ error: "bookId is required" });

  try {
    await sweepExpiredHolds();
    const hold = await prisma.$transaction(async (tx) => {
      const book = await checkMemberMayTake(tx, req.user.id, bookId);
      if ((await freeCopies(tx, book)) < 1)
        throw new Refuse(409, "No copy is free right now. You can join the waiting queue instead");
      const hours = await getNumberSetting(tx, "HOLD_HOURS", 24);
      return tx.hold.create({
        data: { userId: req.user.id, bookId, expiresAt: new Date(Date.now() + hours * HOUR_MS) },
        include: { book: { select: { id: true, title: true } } },
      });
    }, SERIALIZABLE);
    res.status(201).json({ hold });
  } catch (e) {
    sendError(res, e);
  }
});

// GET /api/holds/mine
router.get("/holds/mine", authenticate, async (req, res) => {
  await sweepExpiredHolds().catch(() => {});
  const holds = await prisma.hold.findMany({
    where: { userId: req.user.id, status: "ACTIVE", expiresAt: { gt: new Date() } },
    orderBy: { expiresAt: "asc" },
    include: { book: { select: { id: true, title: true, author: true } } },
  });
  res.json({ holds });
});

// DELETE /api/holds/:id  -> the member gives up their own hold
router.delete("/holds/:id", authenticate, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid hold id" });
  try {
    await prisma.$transaction(async (tx) => {
      const hold = await tx.hold.findUnique({ where: { id } });
      if (!hold || hold.userId !== req.user.id) throw new Refuse(404, "Hold not found");
      if (hold.status !== "ACTIVE") throw new Refuse(400, "This hold is no longer active");
      await tx.hold.update({ where: { id }, data: { status: "CANCELLED" } });
      await tx.reservation.updateMany({
        where: { userId: hold.userId, bookId: hold.bookId, status: "READY" },
        data: { status: "CANCELLED" },
      });
      await promoteQueue(tx, hold.bookId); // the copy goes to the next person in line
    }, SERIALIZABLE);
    res.json({ message: "Hold cancelled" });
  } catch (e) {
    sendError(res, e);
  }
});

// ---------- RESERVATIONS (the waiting queue for a fully borrowed book) ----------

// POST /api/reservations  { bookId }
router.post("/reservations", authenticate, async (req, res) => {
  const bookId = Number(req.body?.bookId);
  if (!Number.isInteger(bookId)) return res.status(400).json({ error: "bookId is required" });

  try {
    await sweepExpiredHolds();
    const reservation = await prisma.$transaction(async (tx) => {
      const book = await checkMemberMayTake(tx, req.user.id, bookId);
      if ((await freeCopies(tx, book)) >= 1)
        throw new Refuse(409, "A copy is available. Hold it instead of joining the queue");
      return tx.reservation.create({
        data: { userId: req.user.id, bookId },
        include: { book: { select: { id: true, title: true } } },
      });
    }, SERIALIZABLE);
    res.status(201).json({ reservation });
  } catch (e) {
    sendError(res, e);
  }
});

// GET /api/reservations/mine  (with queue position)
router.get("/reservations/mine", authenticate, async (req, res) => {
  await sweepExpiredHolds().catch(() => {});
  const mine = await prisma.reservation.findMany({
    where: { userId: req.user.id, status: { in: ["WAITING", "READY"] } },
    orderBy: { id: "asc" },
    include: { book: { select: { id: true, title: true, author: true } } },
  });
  const reservations = await Promise.all(
    mine.map(async (r) => ({
      ...r,
      position:
        r.status === "READY"
          ? 0
          : 1 + (await prisma.reservation.count({ where: { bookId: r.bookId, status: "WAITING", id: { lt: r.id } } })),
    }))
  );
  res.json({ reservations });
});

// DELETE /api/reservations/:id  -> leave the queue
router.delete("/reservations/:id", authenticate, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid reservation id" });
  try {
    await prisma.$transaction(async (tx) => {
      const r = await tx.reservation.findUnique({ where: { id } });
      if (!r || r.userId !== req.user.id) throw new Refuse(404, "Reservation not found");
      if (!["WAITING", "READY"].includes(r.status)) throw new Refuse(400, "This reservation is no longer active");
      await tx.reservation.update({ where: { id }, data: { status: "CANCELLED" } });
      if (r.status === "READY") {
        // they had a hold waiting for them, release it to the next person
        await tx.hold.updateMany({
          where: { userId: r.userId, bookId: r.bookId, status: "ACTIVE" },
          data: { status: "CANCELLED" },
        });
        await promoteQueue(tx, r.bookId);
      }
    }, SERIALIZABLE);
    res.json({ message: "Removed from the queue" });
  } catch (e) {
    sendError(res, e);
  }
});

// ---------- AVAILABILITY ----------

// GET /api/availability/:bookId  -> what the book page shows
router.get("/availability/:bookId", authenticate, async (req, res) => {
  const bookId = Number(req.params.bookId);
  if (!Number.isInteger(bookId)) return res.status(400).json({ error: "Invalid book id" });
  await sweepExpiredHolds().catch(() => {});

  const book = await prisma.book.findUnique({ where: { id: bookId } });
  if (!book) return res.status(404).json({ error: "Book not found" });

  const [onLoan, onHold, waiting] = await Promise.all([
    prisma.loan.count({ where: { bookId, status: "ACTIVE" } }),
    prisma.hold.count({ where: { bookId, status: "ACTIVE", expiresAt: { gt: new Date() } } }),
    prisma.reservation.count({ where: { bookId, status: "WAITING" } }),
  ]);
  const free = Math.max(0, book.totalCopies - onLoan - onHold);
  res.json({
    bookId,
    totalCopies: book.totalCopies,
    onLoan,
    onHold,
    free,
    waiting,
    canHold: book.isIssuable && free > 0,
    canJoinQueue: book.isIssuable && free === 0,
  });
});

module.exports = router;