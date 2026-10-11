require("dotenv").config();
const bcrypt = require("bcryptjs");
const prisma = require("../db");

// rank 1 = highest. grantedByRank = the lowest rank number allowed to give this role (0 = nobody, seed only)
const ROLES = [
  { name: "ADMIN",           rank: 1, grantedByRank: 0, canBorrow: false, maxBooks: 0, loanDays: 0 },
  { name: "LIBRARIAN",       rank: 2, grantedByRank: 1, canBorrow: false, maxBooks: 0, loanDays: 0 },
  { name: "FACULTY",         rank: 3, grantedByRank: 1, canBorrow: true,  maxBooks: 4, loanDays: 14 },
  { name: "PHD",             rank: 4, grantedByRank: 2, canBorrow: true,  maxBooks: 6, loanDays: 30 },
  { name: "STUDENT",         rank: 5, grantedByRank: 2, canBorrow: true,  maxBooks: 4, loanDays: 7 },
  { name: "ALUMNI",          rank: 6, grantedByRank: 2, canBorrow: true,  maxBooks: 2, loanDays: 7 },
  { name: "RETIRED_FACULTY", rank: 7, grantedByRank: 2, canBorrow: true,  maxBooks: 2, loanDays: 7 },
  { name: "REVOKED",         rank: 8, grantedByRank: 2, canBorrow: false, maxBooks: 0, loanDays: 0 },
];

const SETTINGS = {
  HOLD_HOURS: "24",
  HOLD_REMINDER_HOURS: "12",
  RETURN_REMINDER_HOURS_BEFORE: "24",
  MIN_REVOKE_DAYS: "7",
  FINE_WEEK_1: "10",
  FINE_WEEK_2: "20",
  FINE_AFTER_WEEK_2: "50",
};

async function main() {
  // Roles and settings are only created if missing, so re-running never overwrites later edits
  for (const role of ROLES) {
    await prisma.role.upsert({
      where: { name: role.name },
      update: {},
      create: role,
    });
  }

  for (const [key, value] of Object.entries(SETTINGS)) {
    await prisma.setting.upsert({
      where: { key },
      update: {},
      create: { key, value },
    });
  }
  console.log("Roles and settings ready");

  const adminRole = await prisma.role.findUnique({ where: { name: "ADMIN" } });
  const existingAdmin = await prisma.user.findFirst({
    where: { roleId: adminRole.id },
  });

  if (existingAdmin) {
    console.log("An admin already exists:", existingAdmin.email);
    return;
  }

  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD in .env first");
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const admin = await prisma.user.create({
    data: {
      name: "Admin",
      email,
      passwordHash,
      roleId: adminRole.id,
      verifiedAt: new Date(),
    },
  });

  console.log("Admin created:", admin.email);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());