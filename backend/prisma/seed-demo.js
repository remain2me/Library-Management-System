// Demo data for development ONLY. Safe to re-run (no duplicates).
// Run from the backend folder:  node prisma/seed-demo.js
// Every fake record is marked: users have @test.local emails, books have ISBN "DEMO-xxx".
require("dotenv").config();
const prisma = require("../db");

const USERS = [
  { name: "Demo Librarian",   email: "librarian@test.local", role: "LIBRARIAN" },
  { name: "Demo Faculty",     email: "faculty@test.local",   role: "FACULTY", department: "Computer Science" },
  { name: "Demo PhD",         email: "phd@test.local",       role: "PHD", department: "Physics" },
  { name: "Demo Student 1",   email: "student1@test.local",  role: "STUDENT", department: "Computer Science" },
  { name: "Demo Student 2",   email: "student2@test.local",  role: "STUDENT", department: "Mathematics" },
  { name: "Demo Student 3",   email: "student3@test.local",  role: "STUDENT", department: "Chemistry" },
  { name: "Demo Alumni",      email: "alumni@test.local",    role: "ALUMNI" },
  { name: "Demo Retired Faculty", email: "retired@test.local", role: "RETIRED_FACULTY" },
  // No role = waiting for a librarian to verify (tests the pending list)
  { name: "Demo Pending 1",   email: "pending1@test.local",  role: null },
  { name: "Demo Pending 2",   email: "pending2@test.local",  role: null },
];

// [title, author, category, year, copies]
const BOOKS = [
  ["The C Programming Language", "Brian W. Kernighan and Dennis M. Ritchie", "Programming", 1978, 3],
  ["Clean Code", "Robert C. Martin", "Programming", 2008, 2],
  ["Introduction to Algorithms", "Thomas H. Cormen, Charles E. Leiserson, Ronald L. Rivest and Clifford Stein", "Programming", 1990, 4],
  ["Design Patterns", "Erich Gamma, Richard Helm, Ralph Johnson and John Vlissides", "Programming", 1994, 2],
  ["The Pragmatic Programmer", "Andrew Hunt and David Thomas", "Programming", 1999, 2],
  ["Artificial Intelligence: A Modern Approach", "Stuart Russell and Peter Norvig", "Computer Science", 1995, 3],
  ["Operating System Concepts", "Abraham Silberschatz, Peter Baer Galvin and Greg Gagne", "Computer Science", 1983, 3],
  ["Database System Concepts", "Abraham Silberschatz, Henry F. Korth and S. Sudarshan", "Computer Science", 1986, 2],
  ["Computer Networks", "Andrew S. Tanenbaum", "Computer Science", 1981, 2],
  ["The Alchemist", "Paulo Coelho", "Fiction", 1988, 3],
  ["To Kill a Mockingbird", "Harper Lee", "Fiction", 1960, 2],
  ["1984", "George Orwell", "Fiction", 1949, 3],
  ["Pride and Prejudice", "Jane Austen", "Fiction", 1813, 2],
  ["The Great Gatsby", "F. Scott Fitzgerald", "Fiction", 1925, 2],
  ["The Kite Runner", "Khaled Hosseini", "Fiction", 2003, 2],
  ["Midnight's Children", "Salman Rushdie", "Fiction", 1981, 1],
  ["Wings of Fire", "A. P. J. Abdul Kalam and Arun Tiwari", "Biography", 1999, 3],
  ["The Discovery of India", "Jawaharlal Nehru", "History", 1946, 2],
  ["Sapiens: A Brief History of Humankind", "Yuval Noah Harari", "History", 2011, 2],
  ["A Brief History of Time", "Stephen Hawking", "Science", 1988, 3],
  ["Cosmos", "Carl Sagan", "Science", 1980, 2],
  ["The Selfish Gene", "Richard Dawkins", "Science", 1976, 1],
  ["Surely You're Joking, Mr. Feynman!", "Richard P. Feynman", "Science", 1985, 2],
  ["Concepts of Physics", "H. C. Verma", "Physics", 1992, 4],
  ["Calculus", "James Stewart", "Mathematics", 1987, 3],
  ["Linear Algebra and Its Applications", "Gilbert Strang", "Mathematics", 1976, 2],
  ["Atomic Habits", "James Clear", "Self-help", 2018, 3],
  ["The 7 Habits of Highly Effective People", "Stephen R. Covey", "Self-help", 1989, 2],
  ["Rich Dad Poor Dad", "Robert T. Kiyosaki", "Finance", 1997, 2],
  ["The Intelligent Investor", "Benjamin Graham", "Finance", 1949, 1],
];

async function main() {
  const roles = await prisma.role.findMany();
  const roleId = (name) => roles.find((r) => r.name === name)?.id ?? null;
  if (!roles.length) throw new Error("Roles missing. Run the normal seed first: npx prisma db seed (or node prisma/seed.js)");

  for (const u of USERS) {
    const rid = u.role ? roleId(u.role) : null;
    await prisma.user.upsert({
      where: { email: u.email },
      update: {}, // never overwrite changes made while testing
      create: {
        name: u.name,
        email: u.email,
        department: u.department ?? null,
        roleId: rid,
        verifiedAt: rid ? new Date() : null,
      },
    });
  }
  console.log(`Demo users ready (${USERS.length})`);

  let n = 1;
  for (const [title, author, category, publishedYear, totalCopies] of BOOKS) {
    const isbn = `DEMO-${String(n++).padStart(3, "0")}`;
    await prisma.book.upsert({
      where: { isbn },
      update: {},
      create: { title, author, category, publishedYear, totalCopies, isbn }, // overview left empty on purpose
    });
  }
  console.log(`Demo books ready (${BOOKS.length}), overviews left empty`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());