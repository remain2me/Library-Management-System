const express = require("express");
const prisma = require("../db");
const { authenticate, authorize } = require("../middleware/authMiddleware");
const { generateBookOverview } = require("../services/bookOverview");

const router = express.Router();
const staffOnly = [authenticate, authorize("LIBRARIAN")];

const ITEM_TYPES = ["BOOK", "JOURNAL", "MAGAZINE", "NEWSPAPER", "RARE"];
const OVERVIEW_TIMEOUT_MS = 30000;

// Ask the AI for an overview, but never wait more than 30 seconds.
// Returns the text, or null if the AI failed or was too slow.
async function overviewWithTimeout(book) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), OVERVIEW_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      generateBookOverview({
        title: book.title,
        author: book.author,
        category: book.category,
        publishedYear: book.publishedYear,
      }),
      timeout,
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Turn the request body into clean book fields, or return an error message
function cleanBook(body) {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const author = typeof body.author === "string" ? body.author.trim() : "";
  if (!title || !author) return { error: "Title and author are required" };

  const data = { title, author };

  if (body.isbn != null && body.isbn !== "") data.isbn = String(body.isbn).trim();
  if (body.category != null && body.category !== "") data.category = String(body.category).trim();

  if (body.itemType != null) {
    if (!ITEM_TYPES.includes(body.itemType))
      return { error: `itemType must be one of: ${ITEM_TYPES.join(", ")}` };
    data.itemType = body.itemType;
  }
  if (body.isIssuable != null) {
    if (typeof body.isIssuable !== "boolean") return { error: "isIssuable must be true or false" };
    data.isIssuable = body.isIssuable;
  }
  if (body.publishedYear != null && body.publishedYear !== "") {
    const y = Number(body.publishedYear);
    if (!Number.isInteger(y) || y < 1 || y > new Date().getFullYear() + 1)
      return { error: "publishedYear is not a valid year" };
    data.publishedYear = y;
  }
  if (body.price != null && body.price !== "") {
    const p = Number(body.price);
    if (!Number.isFinite(p) || p < 0) return { error: "price must be a positive number" };
    data.price = p;
  }
  if (body.totalCopies != null) {
    const c = Number(body.totalCopies);
    if (!Number.isInteger(c) || c < 1) return { error: "totalCopies must be a whole number, at least 1" };
    data.totalCopies = c;
  }
  return { data };
}

// POST /api/books  -> add a book, then try to generate its overview
router.post("/", staffOnly, async (req, res) => {
  const { data, error } = cleanBook(req.body ?? {});
  if (error) return res.status(400).json({ error });

  let book;
  try {
    book = await prisma.book.create({ data });
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ error: "A book with this ISBN already exists" });
    console.error(e);
    return res.status(500).json({ error: "Could not add the book" });
  }

  // The book is already saved. The overview is a bonus.
  const overview = await overviewWithTimeout(book);
  if (overview) {
    book = await prisma.book.update({ where: { id: book.id }, data: { overview } });
  }

  res.status(201).json({ book, overviewGenerated: Boolean(overview) });
});

// POST /api/books/:id/overview  -> (re)generate the overview for one book
router.post("/:id/overview", staffOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid book id" });

  let book = await prisma.book.findUnique({ where: { id } });
  if (!book) return res.status(404).json({ error: "Book not found" });

  const overview = await overviewWithTimeout(book);
  if (!overview) {
    return res.status(502).json({ error: "The AI could not write an overview right now, please try again" });
  }
  book = await prisma.book.update({ where: { id }, data: { overview } });
  res.json({ book });
});

// GET /api/books?q=&category=&page=&limit=
router.get("/", authenticate, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const category = typeof req.query.category === "string" ? req.query.category.trim() : "";

  const where = {};
  if (q) {
    where.OR = [
      { title: { contains: q, mode: "insensitive" } },
      { author: { contains: q, mode: "insensitive" } },
      { isbn: { contains: q, mode: "insensitive" } },
    ];
  }
  if (category) where.category = { equals: category, mode: "insensitive" };

  const [total, books] = await Promise.all([
    prisma.book.count({ where }),
    prisma.book.findMany({ where, orderBy: { title: "asc" }, skip: (page - 1) * limit, take: limit }),
  ]);
  res.json({ books, total, page, pages: Math.ceil(total / limit) });
});

// GET /api/books/:id
router.get("/:id", authenticate, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid book id" });
  const book = await prisma.book.findUnique({ where: { id } });
  if (!book) return res.status(404).json({ error: "Book not found" });
  res.json({ book });
});

module.exports = router;