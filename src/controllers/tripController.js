// Rides — estimate, request, accept, lifecycle, cancel, history.
const prisma = require('../config/database');
const { asyncHandler, fail, ok } = require('../utils/http');
const { estimateRide } = require('../services/pricing');
const { dispatchTrip } = require('../services/dispatch');
const { computeSurge } = require('../services/surge');
const { credit, debit, getOrCreate, creditTx, debitTx } = require('../services/wallet');
const { notify } = require('../services/notify');

const RIDE_CLASSES = ['ECONOMY', 'PREMIUM', 'BIKE', 'SHARED'];
const PAYMENT_METHODS = ['WALLET', 'CASH', 'MTN_MOMO', 'TELECEL_CASH', 'AIRTELTIGO', 'CARD'];

// Driver-advanceable statuses, in order.
const DRIVER_FLOW = ['ARRIVING', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED'];

// POST /trips/estimate  { rideClass, pickupLat, pickupLng, dropoffLat, dropoffLng }
exports.estimate = asyncHandler(async (req, res) => {
  const { pickupLat, pickupLng, dropoffLat, dropoffLng } = req.body;
  if ([pickupLat, pickupLng, dropoffLat, dropoffLng].some((v) => v == null)) fail(400, 'Pickup and dropoff coordinates required');
  const pickup = { lat: +pickupLat, lng: +pickupLng };
  const dropoff = { lat: +dropoffLat, lng: +dropoffLng };
  const surge = await computeSurge(pickup.lat, pickup.lng);
  const estimates = RIDE_CLASSES.map((c) => ({ rideClass: c, ...estimateRide(c, pickup, dropoff, surge) }));
  return ok(res, { estimates, surge });
});

// POST /trips  { rideClass, pickupAddress, pickupLat, pickupLng, dropoffAddress, dropoffLat, dropoffLng, paymentMethod, scheduledAt?, isShared? }
exports.create = asyncHandler(async (req, res) => {
  const b = req.body;
  if (!RIDE_CLASSES.includes(b.rideClass)) fail(400, 'Invalid ride class');
  if (!PAYMENT_METHODS.includes(b.paymentMethod)) fail(400, 'Invalid payment method');
  for (const k of ['pickupAddress', 'pickupLat', 'pickupLng', 'dropoffAddress', 'dropoffLat', 'dropoffLng']) {
    if (b[k] == null) fail(400, `${k} is required`);
  }
  const pickup = { lat: +b.pickupLat, lng: +b.pickupLng };
  const dropoff = { lat: +b.dropoffLat, lng: +b.dropoffLng };
  const surge = await computeSurge(pickup.lat, pickup.lng);
  const est = estimateRide(b.rideClass, pickup, dropoff, surge);

  // Wallet rides require sufficient balance up front.
  if (b.paymentMethod === 'WALLET') {
    const wallet = await getOrCreate(req.user.id);
    if (Number(wallet.balance) < est.fareEstimate) fail(402, 'Top up your wallet to pay for this ride');
  }

  const trip = await prisma.trip.create({
    data: {
      riderId: req.user.id,
      rideClass: b.rideClass,
      status: b.scheduledAt ? 'SEARCHING' : 'SEARCHING',
      isShared: !!b.isShared,
      scheduledAt: b.scheduledAt ? new Date(b.scheduledAt) : null,
      pickupAddress: b.pickupAddress, pickupLat: pickup.lat, pickupLng: pickup.lng,
      dropoffAddress: b.dropoffAddress, dropoffLat: dropoff.lat, dropoffLng: dropoff.lng,
      distanceMeters: est.distanceMeters, durationSeconds: est.durationSeconds,
      fareEstimate: est.fareEstimate, surgeMultiplier: est.surgeMultiplier,
      paymentMethod: b.paymentMethod, searchingAt: new Date(),
    },
  });

  // Immediate rides dispatch now; scheduled rides are dispatched later by a job.
  if (!b.scheduledAt) {
    const io = req.app.get('io');
    await dispatchTrip(io, trip);
  }
  return ok(res, { trip }, 201);
});

// POST /trips/:id/accept  (driver)
exports.accept = asyncHandler(async (req, res) => {
  const driverProfile = await prisma.driverProfile.findUnique({ where: { userId: req.user.id } });
  if (!driverProfile) fail(403, 'Not a driver');

  // Transaction: only succeed if the trip is still awaiting a driver.
  const trip = await prisma.$transaction(async (tx) => {
    const t = await tx.trip.findUnique({ where: { id: req.params.id } });
    if (!t) return { error: 'Trip not found', status: 404 };
    if (!['DRIVER_ASSIGNED', 'SEARCHING'].includes(t.status)) return { error: 'Trip already taken', status: 409 };
    const updated = await tx.trip.update({
      where: { id: t.id },
      data: { status: 'ACCEPTED', driverId: req.user.id, acceptedAt: new Date() },
    });
    await tx.tripAssignment.updateMany({
      where: { tripId: t.id, driverId: driverProfile.id }, data: { status: 'ACCEPTED', respondedAt: new Date() },
    });
    await tx.tripAssignment.updateMany({
      where: { tripId: t.id, driverId: { not: driverProfile.id }, status: 'OFFERED' }, data: { status: 'CANCELLED' },
    });
    return updated;
  });
  if (trip.error) fail(trip.status, trip.error);

  const io = req.app.get('io');
  const driverInfo = {
    id: req.user.id, fullName: req.user.fullName, profilePhoto: req.user.profilePhoto,
    rating: driverProfile.ratingAvg, vehicle: await prisma.vehicle.findUnique({ where: { driverId: driverProfile.id } }),
  };
  io.to(`user:${trip.riderId}`).emit('trip:status-changed', { tripId: trip.id, status: 'ACCEPTED', driver: driverInfo });
  await notify(io, trip.riderId, {
    title: 'Driver on the way', body: `${req.user.fullName || 'Your driver'} accepted your ride`,
    type: 'RIDE', data: { tripId: trip.id },
  });
  return ok(res, { trip, driver: driverInfo });
});

// POST /trips/:id/decline  (driver) — just records the decline; dispatch continues.
exports.decline = asyncHandler(async (req, res) => {
  const driverProfile = await prisma.driverProfile.findUnique({ where: { userId: req.user.id } });
  if (driverProfile) {
    await prisma.tripAssignment.updateMany({
      where: { tripId: req.params.id, driverId: driverProfile.id, status: 'OFFERED' },
      data: { status: 'DECLINED', respondedAt: new Date() },
    });
  }
  return ok(res, { message: 'Declined' });
});

// PATCH /trips/:id/status  { status }  (driver)
exports.updateStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!DRIVER_FLOW.includes(status)) fail(400, 'Invalid status');
  const trip = await prisma.trip.findUnique({ where: { id: req.params.id } });
  if (!trip) fail(404, 'Trip not found');
  if (trip.driverId !== req.user.id) fail(403, 'Not your trip');
  // Enforce strict, in-order transitions — no skipping (e.g. straight to
  // COMPLETED) and no re-completing a finished trip.
  if (DRIVER_FLOW.indexOf(status) !== DRIVER_FLOW.indexOf(trip.status) + 1) {
    fail(409, `Cannot move from ${trip.status} to ${status}`);
  }

  const io = req.app.get('io');
  const stamp = { ARRIVING: 'arrivingAt', ARRIVED: 'arrivedAt', IN_PROGRESS: 'startedAt', COMPLETED: 'completedAt' }[status];
  const baseData = { status, [stamp]: new Date() };
  const fare = Number(trip.fareEstimate);

  let updated;
  if (status === 'COMPLETED') {
    // Settle atomically: rider debit (WALLET), trip update, driver credit and the
    // trip counter all commit together or not at all. Unique references make it
    // idempotent — a replay can't double-pay. (Cash settles in person; the driver
    // is still credited their earnings either way.)
    updated = await prisma.$transaction(async (tx) => {
      const data = { ...baseData, fareFinal: trip.fareEstimate, paymentStatus: 'PAID' };
      if (trip.paymentMethod === 'WALLET') {
        await debitTx(tx, trip.riderId, fare, 'RIDE_PAYMENT', { contextType: 'TRIP', contextId: trip.id, reference: `RIDE_PAY_${trip.id}` });
      }
      const t = await tx.trip.update({ where: { id: trip.id }, data });
      await creditTx(tx, trip.driverId, fare, 'RIDE_PAYMENT', { contextType: 'TRIP', contextId: trip.id, reference: `RIDE_EARN_${trip.id}` });
      const dp = await tx.driverProfile.findUnique({ where: { userId: trip.driverId } });
      if (dp) await tx.driverProfile.update({ where: { id: dp.id }, data: { totalTrips: { increment: 1 } } });
      return t;
    });
  } else {
    updated = await prisma.trip.update({ where: { id: trip.id }, data: baseData });
  }

  io.to(`user:${trip.riderId}`).emit('trip:status-changed', { tripId: trip.id, status });

  const note = {
    ARRIVED: { title: 'Your driver has arrived', body: 'Head out to meet your driver', type: 'RIDE' },
    COMPLETED: { title: 'Trip complete', body: `Fare GHC ${fare.toFixed(2)} • thanks for riding`, type: 'RIDE' },
  }[status];
  if (note) await notify(io, trip.riderId, { ...note, data: { tripId: trip.id } });

  return ok(res, { trip: updated });
});

// POST /trips/:id/cancel  { reason? }
exports.cancel = asyncHandler(async (req, res) => {
  const trip = await prisma.trip.findUnique({ where: { id: req.params.id } });
  if (!trip) fail(404, 'Trip not found');
  if (![trip.riderId, trip.driverId].includes(req.user.id)) fail(403, 'Not your trip');
  if (['COMPLETED', 'CANCELLED'].includes(trip.status)) fail(409, 'Trip already finished');

  const updated = await prisma.trip.update({
    where: { id: trip.id },
    data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: req.body.reason, cancelledById: req.user.id },
  });
  const io = req.app.get('io');
  const otherParty = req.user.id === trip.riderId ? trip.driverId : trip.riderId;
  if (otherParty) {
    io.to(`user:${otherParty}`).emit('trip:status-changed', { tripId: trip.id, status: 'CANCELLED' });
    await notify(io, otherParty, { title: 'Trip cancelled', body: req.body.reason || 'The other party cancelled', type: 'RIDE', data: { tripId: trip.id } });
  }
  return ok(res, { trip: updated });
});

// GET /trips/:id
exports.getOne = asyncHandler(async (req, res) => {
  const trip = await prisma.trip.findUnique({
    where: { id: req.params.id },
    include: { driver: { select: { id: true, fullName: true, profilePhoto: true, rating: true } } },
  });
  if (!trip) fail(404, 'Trip not found');
  if (![trip.riderId, trip.driverId].includes(req.user.id) && req.user.role === 'USER') fail(403, 'Forbidden');
  return ok(res, { trip });
});

// GET /trips  — rider history
exports.history = asyncHandler(async (req, res) => {
  const trips = await prisma.trip.findMany({
    where: { riderId: req.user.id },
    orderBy: { createdAt: 'desc' }, take: 50,
    include: { driver: { select: { fullName: true, profilePhoto: true } } },
  });
  return ok(res, { trips });
});
