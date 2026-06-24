// Admin — operations, moderation, verification review, analytics.
const prisma = require('../config/database');
const { asyncHandler, fail, ok } = require('../utils/http');
const { credit } = require('../services/wallet');
const { notify } = require('../services/notify');

// GET /admin/dashboard
exports.dashboard = asyncHandler(async (req, res) => {
  const since = new Date(Date.now() - 30 * 86400000);
  const [users, drivers, vendors, trips, orders, listings, openReports, pendingVerifs] = await Promise.all([
    prisma.user.count(),
    prisma.driverProfile.count(),
    prisma.vendor.count(),
    prisma.trip.count({ where: { status: 'COMPLETED' } }),
    prisma.deliveryOrder.count({ where: { status: 'DELIVERED' } }),
    prisma.listing.count({ where: { status: 'ACTIVE' } }),
    prisma.report.count({ where: { status: 'OPEN' } }),
    prisma.verificationRequest.count({ where: { status: { in: ['PENDING', 'UNDER_REVIEW'] } } }),
  ]);
  const revenueAgg = await prisma.walletTransaction.aggregate({
    _sum: { amount: true }, where: { type: 'FEE', createdAt: { gte: since } },
  });
  const tripRevenue = await prisma.trip.aggregate({ _sum: { fareFinal: true }, where: { status: 'COMPLETED', completedAt: { gte: since } } });
  return ok(res, {
    counts: { users, drivers, vendors, completedTrips: trips, deliveredOrders: orders, activeListings: listings, openReports, pendingVerifications: pendingVerifs },
    revenue30d: Number(tripRevenue._sum.fareFinal || 0) + Number(revenueAgg._sum.amount || 0),
  });
});

// GET /admin/live — online drivers & active jobs for the ops map
exports.live = asyncHandler(async (req, res) => {
  const drivers = await prisma.driverProfile.findMany({
    where: { isOnline: true }, include: { user: { select: { fullName: true } }, vehicle: { select: { type: true, plate: true } } },
  });
  const activeTrips = await prisma.trip.count({ where: { status: { in: ['DRIVER_ASSIGNED', 'ACCEPTED', 'ARRIVING', 'ARRIVED', 'IN_PROGRESS'] } } });
  const activeOrders = await prisma.deliveryOrder.count({ where: { status: { in: ['COURIER_ASSIGNED', 'PICKED_UP', 'IN_TRANSIT'] } } });
  return ok(res, {
    drivers: drivers.map((d) => ({ id: d.userId, name: d.user.fullName, lat: d.currentLat, lng: d.currentLng, bearing: d.bearing, vehicle: d.vehicle })),
    activeTrips, activeOrders,
  });
});

// GET /admin/users?q&status
exports.users = asyncHandler(async (req, res) => {
  const { q, status } = req.query;
  const users = await prisma.user.findMany({
    where: {
      ...(status ? { status } : {}),
      ...(q ? { OR: [{ fullName: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }, { phone: { contains: q } }] } : {}),
    },
    orderBy: { createdAt: 'desc' }, take: 100,
    select: { id: true, fullName: true, email: true, phone: true, campusRole: true, status: true, isVerified: true, isDriver: true, isVendor: true, rating: true, createdAt: true },
  });
  return ok(res, { users });
});

// PATCH /admin/users/:id  { status }  — ACTIVE | SUSPENDED | BANNED
exports.setUserStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['ACTIVE', 'SUSPENDED', 'BANNED'].includes(status)) fail(400, 'Invalid status');
  const user = await prisma.user.update({ where: { id: req.params.id }, data: { status } });
  await prisma.auditLog.create({ data: { actorId: req.user.id, action: 'USER_STATUS', entityType: 'User', entityId: user.id, meta: { status } } });
  return ok(res, { user: { id: user.id, status: user.status } });
});

// GET /admin/verifications?status
exports.verifications = asyncHandler(async (req, res) => {
  const status = req.query.status || 'PENDING';
  const requests = await prisma.verificationRequest.findMany({
    where: { status }, orderBy: { submittedAt: 'asc' },
    include: { user: { select: { id: true, fullName: true, email: true, phone: true, address: true } } },
  });
  return ok(res, { verifications: requests });
});

// PATCH /admin/verifications/:id  { decision: 'APPROVED'|'REJECTED', note? }
exports.reviewVerification = asyncHandler(async (req, res) => {
  const { decision, note } = req.body;
  if (!['APPROVED', 'REJECTED'].includes(decision)) fail(400, 'decision must be APPROVED or REJECTED');
  const reqRecord = await prisma.verificationRequest.findUnique({ where: { id: req.params.id } });
  if (!reqRecord) fail(404, 'Verification not found');

  const updated = await prisma.verificationRequest.update({
    where: { id: reqRecord.id }, data: { status: decision, reviewNote: note, reviewedById: req.user.id, reviewedAt: new Date() },
  });

  if (decision === 'APPROVED') {
    if (reqRecord.type === 'DRIVER') {
      await prisma.driverProfile.updateMany({ where: { userId: reqRecord.userId }, data: { status: 'ACTIVE' } });
      await prisma.user.update({ where: { id: reqRecord.userId }, data: { isVerified: true } });
    }
    if (reqRecord.type === 'VENDOR') await prisma.vendor.updateMany({ where: { ownerId: reqRecord.userId }, data: { status: 'APPROVED' } });
    if (reqRecord.type === 'SERVICE_PROVIDER') await prisma.serviceProviderProfile.updateMany({ where: { userId: reqRecord.userId }, data: { status: 'APPROVED' } });
  }
  await prisma.notification.create({
    data: { userId: reqRecord.userId, title: `Verification ${decision.toLowerCase()}`, body: note || `Your ${reqRecord.type} verification was ${decision.toLowerCase()}`, type: 'SYSTEM' },
  });
  req.app.get('io')?.to(`user:${reqRecord.userId}`).emit('notification:new', { title: 'Verification update', body: decision, type: 'SYSTEM' });
  return ok(res, { verification: updated });
});

// GET /admin/reports?status
exports.reports = asyncHandler(async (req, res) => {
  const reports = await prisma.report.findMany({
    where: { status: req.query.status || 'OPEN' }, orderBy: { createdAt: 'desc' }, take: 100,
    include: { reporter: { select: { fullName: true } } },
  });
  return ok(res, { reports });
});

// PATCH /admin/reports/:id  { action: 'ACTIONED'|'DISMISSED', removeListing? }
exports.resolveReport = asyncHandler(async (req, res) => {
  const { action, removeListing } = req.body;
  if (!['ACTIONED', 'DISMISSED'].includes(action)) fail(400, 'Invalid action');
  const report = await prisma.report.findUnique({ where: { id: req.params.id } });
  if (!report) fail(404, 'Report not found');
  if (removeListing && report.targetType === 'LISTING') {
    await prisma.listing.update({ where: { id: report.targetId }, data: { status: 'REMOVED' } }).catch(() => {});
  }
  const updated = await prisma.report.update({ where: { id: report.id }, data: { status: action, resolvedById: req.user.id } });
  return ok(res, { report: updated });
});

// GET /admin/orders?status  — operations view of delivery orders
exports.orders = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const where = status ? { status } : {};
  const [orders, total] = await Promise.all([
    prisma.deliveryOrder.findMany({
      where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit,
      include: { customer: { select: { fullName: true } }, vendor: { select: { name: true } } },
    }),
    prisma.deliveryOrder.count({ where }),
  ]);
  return ok(res, { orders, page, limit, total, hasMore: page * limit < total });
});

// POST /admin/orders/:id/refund  { amount?, reason? }
// Credits the customer's wallet and marks the order refunded. Idempotent: a
// second call on an already-refunded order is rejected.
exports.refundOrder = asyncHandler(async (req, res) => {
  const order = await prisma.deliveryOrder.findUnique({ where: { id: req.params.id } });
  if (!order) fail(404, 'Order not found');
  if (order.refundedAt) fail(409, 'Order already refunded');

  const max = Number(order.total);
  let amount = req.body.amount != null ? parseFloat(req.body.amount) : max;
  if (!(amount > 0)) fail(400, 'Refund amount must be positive');
  if (amount > max) fail(400, `Refund cannot exceed the order total (GHS ${max})`);

  await credit(order.customerId, amount, 'REFUND', { contextType: 'ORDER', contextId: order.id, reference: `REFUND_${order.id}` });
  const updated = await prisma.deliveryOrder.update({
    where: { id: order.id },
    data: { refundedAt: new Date(), refundAmount: amount, refundReason: req.body.reason || null, paymentStatus: 'REFUNDED' },
  });
  await prisma.auditLog.create({ data: { actorId: req.user.id, action: 'ORDER_REFUND', entityType: 'DeliveryOrder', entityId: order.id, meta: { amount } } });

  const io = req.app.get('io');
  await notify(io, order.customerId, { title: 'Refund issued', body: `GHS ${amount.toFixed(2)} was credited to your wallet`, type: 'SYSTEM', data: { orderId: order.id } });
  return ok(res, { order: updated, refunded: amount });
});

// PATCH /admin/vendors/:id  { status }  — approve/suspend vendor
exports.setVendorStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'].includes(status)) fail(400, 'Invalid status');
  const vendor = await prisma.vendor.update({ where: { id: req.params.id }, data: { status } });
  return ok(res, { vendor });
});
