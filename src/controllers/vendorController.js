// Vendors & products (food/shops feeding delivery).
const prisma = require('../config/database');
const { asyncHandler, fail, ok } = require('../utils/http');
const { haversineKm } = require('../utils/geo');

// GET /vendors?lat&lng&category&q
exports.list = asyncHandler(async (req, res) => {
  const { lat, lng, category, q } = req.query;
  const vendors = await prisma.vendor.findMany({
    where: {
      status: 'APPROVED',
      ...(category ? { category } : {}),
      ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
    },
    take: 100,
  });
  let out = vendors;
  if (lat && lng) {
    out = vendors
      .map((v) => ({ ...v, distanceKm: Math.round(haversineKm(+lat, +lng, v.lat, v.lng) * 10) / 10 }))
      .sort((a, b) => a.distanceKm - b.distanceKm);
  }
  return ok(res, { vendors: out });
});

// GET /vendors/:id  (with menu)
exports.getOne = asyncHandler(async (req, res) => {
  const vendor = await prisma.vendor.findUnique({
    where: { id: req.params.id },
    include: { products: { where: { isAvailable: true } } },
  });
  if (!vendor) fail(404, 'Vendor not found');
  return ok(res, { vendor });
});

// ── Vendor-owner endpoints ──
async function myVendor(userId) {
  const v = await prisma.vendor.findUnique({ where: { ownerId: userId } });
  if (!v) throw Object.assign(new Error('No vendor profile — create one first'), { status: 403 });
  return v;
}

// PUT /vendors/me  { name?, description?, isOpen?, openingHours?, prepTimeMinutes?, logoUrl?, coverUrl? }
exports.updateMine = asyncHandler(async (req, res) => {
  const v = await myVendor(req.user.id);
  const b = req.body;
  const data = {};
  for (const k of ['name', 'description', 'logoUrl', 'coverUrl', 'openingHours']) if (b[k] !== undefined) data[k] = b[k];
  if (b.isOpen !== undefined) data.isOpen = !!b.isOpen;
  if (b.prepTimeMinutes !== undefined) data.prepTimeMinutes = +b.prepTimeMinutes;
  const vendor = await prisma.vendor.update({ where: { id: v.id }, data });
  return ok(res, { vendor });
});

// POST /vendors/me/products  { name, price, description?, imageUrl?, category?, options? }
exports.addProduct = asyncHandler(async (req, res) => {
  const v = await myVendor(req.user.id);
  const { name, price, description, imageUrl, category, options } = req.body;
  if (!name || price == null) fail(400, 'name and price required');
  const product = await prisma.product.create({
    data: { vendorId: v.id, name, price: +price, description, imageUrl, category, options: options ?? undefined },
  });
  return ok(res, { product }, 201);
});

// PATCH /vendors/me/products/:productId
exports.updateProduct = asyncHandler(async (req, res) => {
  const v = await myVendor(req.user.id);
  const product = await prisma.product.findUnique({ where: { id: req.params.productId } });
  if (!product || product.vendorId !== v.id) fail(404, 'Product not found');
  const b = req.body;
  const data = {};
  for (const k of ['name', 'description', 'imageUrl', 'category', 'options']) if (b[k] !== undefined) data[k] = b[k];
  if (b.price !== undefined) data.price = +b.price;
  if (b.isAvailable !== undefined) data.isAvailable = !!b.isAvailable;
  const updated = await prisma.product.update({ where: { id: product.id }, data });
  return ok(res, { product: updated });
});

// GET /vendors/me/orders
exports.myOrders = asyncHandler(async (req, res) => {
  const v = await myVendor(req.user.id);
  const orders = await prisma.deliveryOrder.findMany({
    where: { vendorId: v.id }, orderBy: { createdAt: 'desc' }, take: 50, include: { items: true },
  });
  return ok(res, { orders });
});
