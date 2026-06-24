// Universities — the campuses Campus Connect serves (UMaT is the live pilot).
const prisma = require('../config/database');
const { asyncHandler, ok } = require('../utils/http');

// GET /universities  → all campuses, active (live) ones first.
exports.list = asyncHandler(async (req, res) => {
  const universities = await prisma.university.findMany({
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
  });
  return ok(res, { universities });
});
