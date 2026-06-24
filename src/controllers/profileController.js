// Profile — view/update self, and unlock provider capabilities.
const prisma = require('../config/database');
const { asyncHandler, fail, ok } = require('../utils/http');
const { publicUser } = require('./authController');

// GET /profile
exports.get = asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { driverProfile: { include: { vehicle: true } }, vendor: true, serviceProvider: true, wallet: true },
  });
  return ok(res, { user: { ...publicUser(user), address: user.address, defaultLat: user.defaultLat, defaultLng: user.defaultLng,
    driverProfile: user.driverProfile, vendor: user.vendor, serviceProvider: user.serviceProvider,
    walletBalance: user.wallet?.balance ?? 0 } });
});

// PUT /profile  { fullName?, phone?, address?, defaultLat?, defaultLng?, profilePhoto?, fcmToken?, studentId?, campusRole? }
exports.update = asyncHandler(async (req, res) => {
  const f = req.body;
  const data = {};
  for (const k of ['fullName', 'phone', 'address', 'profilePhoto', 'fcmToken', 'studentId']) {
    if (f[k] !== undefined) data[k] = f[k];
  }
  if (f.defaultLat !== undefined) data.defaultLat = parseFloat(f.defaultLat);
  if (f.defaultLng !== undefined) data.defaultLng = parseFloat(f.defaultLng);
  if (f.campusRole && ['STUDENT', 'STAFF', 'NON_STUDENT'].includes(f.campusRole)) data.campusRole = f.campusRole;
  if (f.universityId !== undefined) data.universityId = f.universityId;

  const user = await prisma.user.update({ where: { id: req.user.id }, data });
  return ok(res, { user: publicUser(user) });
});

// POST /profile/become-driver  { doesRides?, doesDelivery? }
exports.becomeDriver = asyncHandler(async (req, res) => {
  const existing = await prisma.driverProfile.findUnique({ where: { userId: req.user.id } });
  if (existing) return ok(res, { driverProfile: existing, message: 'Driver profile already exists' });
  const driverProfile = await prisma.driverProfile.create({
    data: {
      userId: req.user.id,
      doesRides: req.body.doesRides ?? true,
      doesDelivery: req.body.doesDelivery ?? false,
    },
  });
  await prisma.user.update({ where: { id: req.user.id }, data: { isDriver: true } });
  return ok(res, { driverProfile, message: 'Driver profile created — submit verification to go live' }, 201);
});

// POST /profile/become-vendor  { name, category, address, lat, lng, description? }
exports.becomeVendor = asyncHandler(async (req, res) => {
  const { name, category, address, lat, lng, description } = req.body;
  if (!name || !category || !address || lat == null || lng == null) fail(400, 'name, category, address, lat, lng are required');
  const existing = await prisma.vendor.findUnique({ where: { ownerId: req.user.id } });
  if (existing) return ok(res, { vendor: existing, message: 'Vendor already exists' });
  const vendor = await prisma.vendor.create({
    data: { ownerId: req.user.id, name, category, address, lat: parseFloat(lat), lng: parseFloat(lng), description },
  });
  await prisma.user.update({ where: { id: req.user.id }, data: { isVendor: true } });
  return ok(res, { vendor, message: 'Vendor created — pending admin approval' }, 201);
});

// POST /profile/become-provider  { bio? }
exports.becomeProvider = asyncHandler(async (req, res) => {
  const existing = await prisma.serviceProviderProfile.findUnique({ where: { userId: req.user.id } });
  if (existing) return ok(res, { provider: existing });
  const provider = await prisma.serviceProviderProfile.create({ data: { userId: req.user.id, bio: req.body.bio } });
  await prisma.user.update({ where: { id: req.user.id }, data: { isServiceProvider: true } });
  return ok(res, { provider, message: 'Service provider created — pending verification' }, 201);
});
