const prisma = require("../db");

// If a user's Revoke period has ended, give their old role back.
// Returns the user (updated if it was restored), with their role included.
async function restoreIfExpired(user) {
  const isRevoked = user.role && user.role.name === "REVOKED";
  const hasEnded = user.revokedUntil && user.revokedUntil <= new Date();

  if (!isRevoked || !hasEnded) return user;

  const [updated] = await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: {
        roleId: user.previousRoleId,
        previousRoleId: null,
        revokedUntil: null,
        revokeReason: null,
        revokedById: null,
      },
      include: { role: true },
    }),
    prisma.roleChange.create({
      data: {
        userId: user.id,
        fromRoleId: user.roleId,
        toRoleId: user.previousRoleId,
        changedById: null,
        reason: "Revoke period ended",
      },
    }),
  ]);

  return updated;
}

module.exports = { restoreIfExpired };