// Marketplace listings.
const prisma = require('../config/database');
const { asyncHandler, fail, ok } = require('../utils/http');

const CONDITIONS = ['NEW', 'LIKE_NEW', 'USED', 'FOR_PARTS'];

// GET /categories?type=MARKETPLACE|SERVICE|VENDOR
exports.categories = asyncHandler(async (req, res) => {
  const { type } = req.query;
  const categories = await prisma.category.findMany({
    where: type ? { type } : {}, orderBy: { name: 'asc' },
  });
  return ok(res, { categories });
});

// GET /listings?q&categoryId&min&max&condition&page&limit
exports.list = asyncHandler(async (req, res) => {
  const { q, categoryId, min, max, condition } = req.query;
  // Pagination: ?page=1&limit=20 (limit capped at 60). `?limit=` alone still works.
  const limit = Math.min(60, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const where = {
    status: 'ACTIVE',
    ...(categoryId ? { categoryId } : {}),
    ...(condition && CONDITIONS.includes(condition) ? { condition } : {}),
    ...(q ? { OR: [{ title: { contains: q, mode: 'insensitive' } }, { description: { contains: q, mode: 'insensitive' } }] } : {}),
    ...(min || max ? { price: { ...(min ? { gte: +min } : {}), ...(max ? { lte: +max } : {}) } } : {}),
  };
  const [listings, total] = await Promise.all([
    prisma.listing.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: { images: { orderBy: { position: 'asc' } }, category: true, seller: { select: { fullName: true, profilePhoto: true, rating: true } } },
    }),
    prisma.listing.count({ where }),
  ]);
  return ok(res, { listings, page, limit, total, hasMore: page * limit < total });
});

// GET /listings/:id  (increments views)
exports.getOne = asyncHandler(async (req, res) => {
  const listing = await prisma.listing.update({
    where: { id: req.params.id }, data: { viewCount: { increment: 1 } },
    include: { images: { orderBy: { position: 'asc' } }, category: true, seller: { select: { id: true, fullName: true, profilePhoto: true, rating: true, phone: true } } },
  }).catch(() => null);
  if (!listing) fail(404, 'Listing not found');
  return ok(res, { listing });
});

// POST /listings  { title, description, price, categoryId, condition?, negotiable?, locationName?, lat?, lng?, images?[] }
exports.create = asyncHandler(async (req, res) => {
  const b = req.body;
  if (!b.title || !b.description || b.price == null || !b.categoryId) fail(400, 'title, description, price, categoryId required');
  const listing = await prisma.listing.create({
    data: {
      sellerId: req.user.id, title: b.title, description: b.description, price: +b.price,
      categoryId: b.categoryId, condition: CONDITIONS.includes(b.condition) ? b.condition : 'USED',
      negotiable: !!b.negotiable, locationName: b.locationName,
      lat: b.lat != null ? +b.lat : null, lng: b.lng != null ? +b.lng : null,
      images: { create: (b.images || []).slice(0, 8).map((url, i) => ({ url, position: i })) },
    },
    include: { images: true },
  });
  return ok(res, { listing }, 201);
});

// PATCH /listings/:id  — owner edits / marks sold
exports.update = asyncHandler(async (req, res) => {
  const listing = await prisma.listing.findUnique({ where: { id: req.params.id } });
  if (!listing) fail(404, 'Listing not found');
  if (listing.sellerId !== req.user.id) fail(403, 'Not your listing');
  const b = req.body;
  const data = {};
  for (const k of ['title', 'description', 'locationName']) if (b[k] !== undefined) data[k] = b[k];
  if (b.price !== undefined) data.price = +b.price;
  if (b.negotiable !== undefined) data.negotiable = !!b.negotiable;
  if (b.status && ['ACTIVE', 'SOLD', 'REMOVED', 'DRAFT'].includes(b.status)) data.status = b.status;
  const updated = await prisma.listing.update({ where: { id: listing.id }, data });
  return ok(res, { listing: updated });
});

// DELETE /listings/:id
exports.remove = asyncHandler(async (req, res) => {
  const listing = await prisma.listing.findUnique({ where: { id: req.params.id } });
  if (!listing) fail(404, 'Listing not found');
  if (listing.sellerId !== req.user.id) fail(403, 'Not your listing');
  await prisma.listing.update({ where: { id: listing.id }, data: { status: 'REMOVED' } });
  return ok(res, { message: 'Removed' });
});

// GET /listings/mine
exports.mine = asyncHandler(async (req, res) => {
  const listings = await prisma.listing.findMany({
    where: { sellerId: req.user.id, status: { not: 'REMOVED' } }, orderBy: { createdAt: 'desc' },
    include: { images: { orderBy: { position: 'asc' } } },
  });
  return ok(res, { listings });
});

// POST /listings/:id/favorite  (toggle)
exports.toggleFavorite = asyncHandler(async (req, res) => {
  const existing = await prisma.favorite.findUnique({ where: { userId_listingId: { userId: req.user.id, listingId: req.params.id } } }).catch(() => null);
  if (existing) {
    await prisma.favorite.delete({ where: { id: existing.id } });
    await prisma.listing.update({ where: { id: req.params.id }, data: { favoriteCount: { decrement: 1 } } });
    return ok(res, { favorited: false });
  }
  await prisma.favorite.create({ data: { userId: req.user.id, listingId: req.params.id } });
  await prisma.listing.update({ where: { id: req.params.id }, data: { favoriteCount: { increment: 1 } } });
  return ok(res, { favorited: true });
});

// GET /listings/favorites
exports.favorites = asyncHandler(async (req, res) => {
  const favs = await prisma.favorite.findMany({
    where: { userId: req.user.id, listingId: { not: null } },
    include: { listing: { include: { images: { orderBy: { position: 'asc' } } } } },
  });
  return ok(res, { listings: favs.map((f) => f.listing).filter(Boolean) });
});

// POST /listings/:id/report  { reason, note? }
exports.report = asyncHandler(async (req, res) => {
  if (!req.body.reason) fail(400, 'reason required');
  await prisma.report.create({
    data: { reporterId: req.user.id, targetType: 'LISTING', targetId: req.params.id, reason: req.body.reason, note: req.body.note },
  });
  return ok(res, { message: 'Reported — thank you' });
});
