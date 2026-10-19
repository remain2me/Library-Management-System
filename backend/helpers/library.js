// Shared rules for loans, holds and the waiting queue.
const prisma = require("../db");

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// Stop inside a transaction and send a clean message to the client
class Refuse extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendError(res, e) {
  if (e instanceof Refuse) return res.status(e.status).json({ error: e.message });
  if (e.code === "P2034") return res.status(409).json({ error: "Someone else was changing this at the same time, please try again" });
  if (e.code === "P2002") return res.status(409).json({ error: "This has already been done" });
  console.error(e);
  return res.status(500).json({ error: "Something went wrong" });
}

// Read a number from the Setting table, with a fallback if the row does not exist
async function getNumberSetting(tx, key, fallback) {
  const row = await tx.setting.findUnique({ where: { key } });
  const n = row ? Number(row.value) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

// Copies free right now = total copies - unreturned loans - live holds
// (exceptUserId: ignore that member's own hold, used when they collect it)
async function freeCopies(tx, book, exceptUserId) {
  const holdWhere = { bookId: book.id, status: "ACTIVE", expiresAt: { gt: new Date() } };
  if (exceptUserId) holdWhere.NOT = { userId: exceptUserId };
  const [loans, holds] = await Promise.all([
    tx.loan.count({ where: { bookId: book.id, status: "ACTIVE" } }),
    tx.hold.count({ where: holdWhere }),
  ]);
  return book.totalCopies - loans - holds;
}

// Does this member owe any unpaid fine? (rule 19)
function hasUnpaidFines(tx, userId) {
  return tx.fine.count({ where: { paid: false, loan: { borrowerId: userId } } });
}

// Books a member is using up their limit with: loans + live holds
async function usedSlots(tx, userId) {
  const [loans, holds] = await Promise.all([
    tx.loan.count({ where: { borrowerId: userId, status: "ACTIVE" } }),
    tx.hold.count({ where: { userId, status: "ACTIVE", expiresAt: { gt: new Date() } } }),
  ]);
  return loans + holds;
}

// When a copy becomes free, give it to the people waiting, oldest first.
// "Giving" = create a 24 hour hold for them and mark their reservation READY.
// The email "book is back in stock" is sent later by the scheduler (notifiedAt stays empty until then).
async function promoteQueue(tx, bookId) {
  const book = await tx.book.findUnique({ where: { id: bookId } });
  if (!book) return;
  const holdHours = await getNumberSetting(tx, "HOLD_HOURS", 24);

  while ((await freeCopies(tx, book)) >= 1) {
    const next = await tx.reservation.findFirst({
      where: { bookId, status: "WAITING" },
      orderBy: { id: "asc" },
      include: { user: { include: { role: true } } },
    });
    if (!next) break;

    const u = next.user;
    const stillAllowed =
      u.isActive &&
      u.role?.canBorrow &&
      (await usedSlots(tx, u.id)) < u.role.maxBooks &&
      !(await hasUnpaidFines(tx, u.id));

    if (!stillAllowed) {
      await tx.reservation.update({ where: { id: next.id }, data: { status: "CANCELLED" } });
      continue;
    }
    await tx.hold.create({
      data: { userId: u.id, bookId, expiresAt: new Date(Date.now() + holdHours * HOUR_MS) },
    });
    await tx.reservation.update({ where: { id: next.id }, data: { status: "READY" } });
  }
}

// Holds whose 24 hours ran out: mark them EXPIRED and pass the copy to the next in the queue.
// Routes call this before they work, and the scheduler will call it every few minutes.
async function sweepExpiredHolds(db = prisma) {
  const expired = await db.hold.findMany({
    where: { status: "ACTIVE", expiresAt: { lt: new Date() } },
    select: { id: true, userId: true, bookId: true },
  });
  if (!expired.length) return 0;

  await db.$transaction(
    async (tx) => {
      for (const h of expired) {
        await tx.hold.update({ where: { id: h.id }, data: { status: "EXPIRED" } });
        await tx.reservation.updateMany({
          where: { userId: h.userId, bookId: h.bookId, status: "READY" },
          data: { status: "CANCELLED" },
        });
      }
      for (const bookId of new Set(expired.map((h) => h.bookId))) await promoteQueue(tx, bookId);
    },
    { isolationLevel: "Serializable" }
  );
  return expired.length;
}

// Cancel everything a member is holding or waiting for (used by revoke and deactivate).
// Their loans are NOT touched. Frees the copies for the next people in line.
async function cancelUserHoldsAndQueue(tx, userId) {
  const holds = await tx.hold.findMany({ where: { userId, status: "ACTIVE" }, select: { id: true, bookId: true } });
  await tx.hold.updateMany({ where: { userId, status: "ACTIVE" }, data: { status: "CANCELLED" } });
  await tx.reservation.updateMany({
    where: { userId, status: { in: ["WAITING", "READY"] } },
    data: { status: "CANCELLED" },
  });
  for (const bookId of new Set(holds.map((h) => h.bookId))) await promoteQueue(tx, bookId);
}

module.exports = {
  DAY_MS,
  HOUR_MS,
  Refuse,
  sendError,
  getNumberSetting,
  freeCopies,
  hasUnpaidFines,
  usedSlots,
  promoteQueue,
  sweepExpiredHolds,
  cancelUserHoldsAndQueue,
};