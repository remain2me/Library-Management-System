const express = require("express");
const prisma = require("../db");
const { authenticate, authorize } = require("../middleware/authMiddleware");
const {
  DAY_MS,
  Refuse,
  sendError,
  getNumberSetting,
  freeCopies,
  hasUnpaidFines,
  promoteQueue,
  sweepExpiredHolds,
} = require("../helpers/library");

const router = express.Router();
const staffOnly = [authenticate, authorize("LIBRARIAN")];
// How many days late a loan is (any part of a day counts as a full day)
function daysOverdue(dueDate, now = new Date()) {
  return now > dueDate ? Math.ceil((now - dueDate) / DAY_MS) : 0;
}

// POST /api/loans  { borrowerId, bookId }  -> librarian issues a book
router.post("/", staffOnly, async (req, res) => {
  const borrowerId = Number(req.body?.borrowerId);
  const bookId = Number(req.body?.bookId);
  if (!Number.isInteger(borrowerId) || !Number.isInteger(bookId))
    return res.status(400).json({ error: "borrowerId and bookId are required" });

  try {
    await sweepExpiredHolds();
    const loan = await prisma.$transaction(
      async (tx) => {
        const borrower = await tx.user.findUnique({ where: { id: borrowerId }, include: { role: true } });
        if (!borrower) throw new Refuse(404, "Member not found");
        if (!borrower.isActive) throw new Refuse(403, "This account is deactivated");
        if (!borrower.role) throw new Refuse(403, "This member has not been verified yet");
        if (!borrower.role.canBorrow)
          throw new Refuse(403, `${borrower.role.name} members cannot borrow books`);

        const book = await tx.book.findUnique({ where: { id: bookId } });
        if (!book) throw new Refuse(404, "Book not found");
        if (!book.isIssuable) throw new Refuse(400, "This item cannot be issued for home use");

        const current = await tx.loan.count({ where: { borrowerId, status: "ACTIVE" } });
        if (current >= borrower.role.maxBooks)
          throw new Refuse(400, `Borrowing limit reached (${borrower.role.maxBooks} books)`);

        if (await hasUnpaidFines(tx, borrowerId))
          throw new Refuse(400, "This member has unpaid fines. Dues must be cleared first");

        const already = await tx.loan.count({ where: { borrowerId, bookId, status: "ACTIVE" } });
        if (already) throw new Refuse(400, "This member already has this book");

        // If the member flagged (held) this book, collecting it turns the hold into the loan
        const hold = await tx.hold.findFirst({
          where: { userId: borrowerId, bookId, status: "ACTIVE", expiresAt: { gt: new Date() } },
        });

        if ((await freeCopies(tx, book, borrowerId)) < 1 && !hold)
          throw new Refuse(409, "No copy is available right now");

        if (hold) {
          await tx.hold.update({ where: { id: hold.id }, data: { status: "COLLECTED" } });
          // if they got this hold through the waiting queue, that reservation is now fulfilled
          await tx.reservation.updateMany({
            where: { userId: borrowerId, bookId, status: "READY" },
            data: { status: "FULFILLED" },
          });
        }

        return tx.loan.create({
          data: {
            borrowerId,
            bookId,
            issuedById: req.user.id,
            holdId: hold ? hold.id : null,
            dueDate: new Date(Date.now() + borrower.role.loanDays * DAY_MS),
          },
          include: { book: { select: { id: true, title: true, author: true } } },
        });
      },
      { isolationLevel: "Serializable" }
    );
    res.status(201).json({ loan });
  } catch (e) {
    sendError(res, e);
  }
});

// POST /api/loans/:id/return  { conditionNote? }  -> librarian receives a book back
router.post("/:id/return", staffOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid loan id" });

  try {
    const existing = await prisma.loan.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Loan not found" });
    if (existing.status !== "ACTIVE") return res.status(400).json({ error: "This loan is not active" });

    const note = typeof req.body?.conditionNote === "string" ? req.body.conditionNote.trim() : null;
    const returnedAt = new Date();
    const loan = await prisma.loan.update({
      where: { id },
      data: { status: "RETURNED", returnedAt, receivedById: req.user.id, conditionNote: note || null },
      include: { book: { select: { id: true, title: true } } },
    });
    // The copy is back: give it to the next member in the waiting queue, if any
    await prisma.$transaction((tx) => promoteQueue(tx, existing.bookId), { isolationLevel: "Serializable" });
    // Fines are created in the fines step. For now we just report how late it was.
    res.json({ loan, daysOverdue: daysOverdue(existing.dueDate, returnedAt) });
  } catch (e) {
    sendError(res, e);
  }
});

// POST /api/loans/:id/renew  -> extend the due date
router.post("/:id/renew", staffOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid loan id" });

  try {
    const loan = await prisma.$transaction(
      async (tx) => {
        const l = await tx.loan.findUnique({ where: { id }, include: { borrower: { include: { role: true } } } });
        if (!l) throw new Refuse(404, "Loan not found");
        if (l.status !== "ACTIVE") throw new Refuse(400, "This loan is not active");
        if (!l.borrower.role?.canBorrow) throw new Refuse(403, "This member cannot borrow right now");
        if (new Date() > l.dueDate) throw new Refuse(400, "An overdue book cannot be renewed. Return it first");

        const maxRenewals = await getNumberSetting(tx, "MAX_RENEWALS", 1);
        if (l.renewalCount >= maxRenewals) throw new Refuse(400, `This book was already renewed ${maxRenewals} time(s)`);

        if (await hasUnpaidFines(tx, l.borrowerId))
          throw new Refuse(400, "This member has unpaid fines. Dues must be cleared first");

        const waiting = await tx.reservation.count({ where: { bookId: l.bookId, status: { in: ["WAITING", "READY"] } } });
        if (waiting > 0) throw new Refuse(409, "Other members are waiting for this book, so it cannot be renewed");

        return tx.loan.update({
          where: { id },
          data: {
            renewalCount: { increment: 1 },
            dueDate: new Date(Date.now() + l.borrower.role.loanDays * DAY_MS),
            reminderSentAt: null,
          },
        });
      },
      { isolationLevel: "Serializable" }
    );
    res.json({ loan });
  } catch (e) {
    sendError(res, e);
  }
});

// GET /api/loans/mine  -> the signed-in member's own loans
router.get("/mine", authenticate, async (req, res) => {
  const loans = await prisma.loan.findMany({
    where: { borrowerId: req.user.id },
    orderBy: { issuedAt: "desc" },
    include: { book: { select: { id: true, title: true, author: true } } },
  });
  res.json({ loans: loans.map((l) => ({ ...l, daysOverdue: l.status === "ACTIVE" ? daysOverdue(l.dueDate) : 0 })) });
});

// GET /api/loans?status=ACTIVE&userId=&overdue=true  -> librarian's list
router.get("/", staffOnly, async (req, res) => {
  const where = {};
  if (req.query.status) where.status = String(req.query.status).toUpperCase();
  if (req.query.userId) where.borrowerId = Number(req.query.userId);
  if (req.query.overdue === "true") {
    where.status = "ACTIVE";
    where.dueDate = { lt: new Date() };
  }
  const loans = await prisma.loan.findMany({
    where,
    orderBy: { dueDate: "asc" },
    take: 100,
    include: {
      book: { select: { id: true, title: true } },
      borrower: { select: { id: true, name: true, email: true } },
    },
  });
  res.json({ loans: loans.map((l) => ({ ...l, daysOverdue: l.status === "ACTIVE" ? daysOverdue(l.dueDate) : 0 })) });
});

module.exports = router;