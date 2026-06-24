// Reviews — polymorphic ratings for drivers, trips, vendors, orders, listings, services.
const prisma = require('../config/database');
const { asyncHandler, fail, ok } = require('../utils/http');

const SUBJECTS = ['DRIVER', 'TRIP', 'VENDOR', 'ORDER', 'LISTING', 'SERVICE', 'SERVICE_PROVIDER'];

// POST /reviews  { subjectType, subjectId, rating, comment?, targetUserId? }
exports.create = asyncHandler(async (req, res) => {
  const { subjectType, subjectId, rating, comment, targetUserId } = req.body;
  if (!SUBJECTS.includes(subjectType)) fail(400, 'Invalid subject type');
  if (!subjectId) fail(400, 'subjectId required');
  const r = parseInt(rating, 10);
  if (!(r >= 1 && r <= 5)) fail(400, 'rating must be 1-5');

  const review = await prisma.review.create({
    data: { authorId: req.user.id, subjectType, subjectId, rating: r, comment, targetUserId },
  });

  // Recompute aggregate on the relevant entity.
  const agg = await prisma.review.aggregate({ where: { subjectType, subjectId }, _avg: { rating: true }, _count: true });
  const avg = Number(agg._avg.rating || 0);
  const count = agg._count;
  if (subjectType === 'VENDOR') await prisma.vendor.update({ where: { id: subjectId }, data: { ratingAvg: avg, ratingCount: count } }).catch(() => {});
  if (subjectType === 'SERVICE') await prisma.serviceListing.update({ where: { id: subjectId }, data: { ratingAvg: avg, ratingCount: count } }).catch(() => {});
  if (targetUserId) {
    const uAgg = await prisma.review.aggregate({ where: { targetUserId }, _avg: { rating: true }, _count: true });
    await prisma.user.update({ where: { id: targetUserId }, data: { rating: Number(uAgg._avg.rating || 5), reviewCount: uAgg._count } }).catch(() => {});
    const dp = await prisma.driverProfile.findUnique({ where: { userId: targetUserId } });
    if (dp) await prisma.driverProfile.update({ where: { id: dp.id }, data: { ratingAvg: Number(uAgg._avg.rating || 5), ratingCount: uAgg._count } });
  }
  return ok(res, { review }, 201);
});

// GET /reviews?subjectType&subjectId
exports.list = asyncHandler(async (req, res) => {
  const { subjectType, subjectId } = req.query;
  const reviews = await prisma.review.findMany({
    where: { subjectType, subjectId }, orderBy: { createdAt: 'desc' }, take: 50,
    include: { author: { select: { fullName: true, profilePhoto: true } } },
  });
  return ok(res, { reviews });
});
