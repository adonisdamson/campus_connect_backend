// Driver/Partner — status, location, vehicle, jobs, earnings dashboard.
const prisma = require('../config/database');
const { asyncHandler, fail, ok } = require('../utils/http');

async function myProfile(userId) {
  const p = await prisma.driverProfile.findUnique({ where: { userId } });
  if (!p) throw Object.assign(new Error('Not a driver — create a driver profile first'), { status: 403 });
  return p;
}

// PUT /drivers/vehicle  { type, plate, make?, model?, color?, year?, capacity?, photoUrl?, licenseUrl?, insuranceUrl? }
exports.upsertVehicle = asyncHandler(async (req, res) => {
  const p = await myProfile(req.user.id);
  const b = req.body;
  if (!b.type || !['CAR', 'MOTORCYCLE'].includes(b.type)) fail(400, 'Vehicle type must be CAR or MOTORCYCLE');
  if (!b.plate) fail(400, 'Plate is required');
  const data = {
    type: b.type, plate: b.plate, make: b.make, model: b.model, color: b.color,
    year: b.year ? +b.year : null, capacity: b.capacity ? +b.capacity : b.type === 'MOTORCYCLE' ? 1 : 4,
    photoUrl: b.photoUrl, licenseUrl: b.licenseUrl, insuranceUrl: b.insuranceUrl,
  };
  const vehicle = await prisma.vehicle.upsert({
    where: { driverId: p.id }, update: data, create: { driverId: p.id, ...data },
  });
  return ok(res, { vehicle });
});

// GET /drivers/vehicle
exports.getVehicle = asyncHandler(async (req, res) => {
  const p = await myProfile(req.user.id);
  const vehicle = await prisma.vehicle.findUnique({ where: { driverId: p.id } });
  return ok(res, { vehicle });
});

// POST /drivers/online  { lat, lng }   /  POST /drivers/offline
exports.setOnline = asyncHandler(async (req, res) => {
  const p = await myProfile(req.user.id);
  if (p.status === 'SUSPENDED') fail(403, 'Account suspended');
  // Approval gate: `status` becomes ACTIVE only when admin approves the driver's
  // verification. Going online must never set it — only toggle `isOnline`.
  if (p.status !== 'ACTIVE') fail(403, 'Your driver account is pending verification approval');
  // A driver needs a registered, approved vehicle before they can take jobs.
  const vehicle = await prisma.vehicle.findUnique({ where: { driverId: p.id } });
  if (!vehicle) fail(403, 'Register a vehicle before going online');
  if (vehicle.status === 'REJECTED') fail(403, 'Your vehicle was rejected — update it for re-review');
  const { lat, lng } = req.body;
  await prisma.driverProfile.update({
    where: { id: p.id },
    data: { isOnline: true, currentLat: lat != null ? +lat : p.currentLat, currentLng: lng != null ? +lng : p.currentLng, lastSeenAt: new Date() },
  });
  await prisma.driverSession.create({ data: { driverId: p.id } });
  return ok(res, { isOnline: true });
});

exports.setOffline = asyncHandler(async (req, res) => {
  const p = await myProfile(req.user.id);
  await prisma.driverProfile.update({ where: { id: p.id }, data: { isOnline: false } });
  await prisma.driverSession.updateMany({ where: { driverId: p.id, endedAt: null }, data: { endedAt: new Date() } });
  return ok(res, { isOnline: false });
});

// PATCH /drivers/location  { lat, lng, bearing? }
exports.updateLocation = asyncHandler(async (req, res) => {
  const p = await myProfile(req.user.id);
  const { lat, lng, bearing } = req.body;
  if (lat == null || lng == null) fail(400, 'lat and lng required');
  await prisma.driverProfile.update({
    where: { id: p.id }, data: { currentLat: +lat, currentLng: +lng, bearing: bearing != null ? +bearing : null, lastSeenAt: new Date() },
  });
  return ok(res, { updated: true });
});

// GET /drivers/jobs?status=active|completed
exports.jobs = asyncHandler(async (req, res) => {
  const status = req.query.status || 'active';
  const activeStatuses = ['ACCEPTED', 'ARRIVING', 'ARRIVED', 'IN_PROGRESS'];
  const trips = await prisma.trip.findMany({
    where: { driverId: req.user.id, status: status === 'completed' ? 'COMPLETED' : { in: activeStatuses } },
    orderBy: { updatedAt: 'desc' }, take: 50,
    include: { rider: { select: { fullName: true, profilePhoto: true, phone: true } } },
  });
  const orders = await prisma.deliveryOrder.findMany({
    where: { courierId: req.user.id, status: status === 'completed' ? 'DELIVERED' : { in: ['COURIER_ASSIGNED', 'PICKED_UP', 'IN_TRANSIT'] } },
    orderBy: { updatedAt: 'desc' }, take: 50,
  });
  return ok(res, { trips, orders });
});

// GET /drivers/dashboard — earnings + performance
exports.dashboard = asyncHandler(async (req, res) => {
  const p = await myProfile(req.user.id);
  const wallet = await prisma.wallet.findUnique({ where: { userId: req.user.id } });
  const since = (days) => new Date(Date.now() - days * 86400000);

  const sum = async (from) => {
    const r = await prisma.walletTransaction.aggregate({
      _sum: { amount: true },
      where: { wallet: { userId: req.user.id }, type: { in: ['RIDE_PAYMENT', 'ORDER_PAYMENT'] }, createdAt: { gte: from } },
    });
    return Number(r._sum.amount || 0);
  };
  return ok(res, {
    profile: {
      isOnline: p.isOnline, ratingAvg: p.ratingAvg, ratingCount: p.ratingCount,
      totalTrips: p.totalTrips, acceptanceRate: p.acceptanceRate, completionRate: p.completionRate,
    },
    balance: Number(wallet?.balance || 0),
    earnings: { today: await sum(since(1)), week: await sum(since(7)), month: await sum(since(30)) },
  });
});
