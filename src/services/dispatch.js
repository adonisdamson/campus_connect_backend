// Dispatch — match an online driver to a trip or delivery order.
// Broadcasts the job to the nearest available drivers; first to accept wins
// (accept is guarded transactionally in the controller).
const prisma = require('../config/database');
const logger = require('../config/logger');
const { haversineKm } = require('../utils/geo');

const RADIUS_KM = 8;
const FANOUT = 6; // offer to up to N nearest drivers at once
const OFFER_TTL_MS = 30000;

// Find online drivers near a point, optionally filtered by vehicle/service.
async function nearbyDrivers(lat, lng, { needsBike = false, delivery = false } = {}) {
  const drivers = await prisma.driverProfile.findMany({
    where: {
      isOnline: true,
      status: 'ACTIVE',
      currentLat: { not: null },
      currentLng: { not: null },
      ...(delivery ? { doesDelivery: true } : { doesRides: true }),
      ...(needsBike ? { vehicle: { type: 'MOTORCYCLE' } } : {}),
    },
    include: { vehicle: true, user: true },
  });
  return drivers
    .map((d) => ({ d, km: haversineKm(lat, lng, d.currentLat, d.currentLng) }))
    .filter((x) => x.km <= RADIUS_KM)
    .sort((a, b) => a.km - b.km)
    .slice(0, FANOUT)
    .map((x) => ({ ...x.d, distanceKm: Math.round(x.km * 100) / 100 }));
}

// Offer a trip to nearby drivers.
async function dispatchTrip(io, trip) {
  const drivers = await nearbyDrivers(trip.pickupLat, trip.pickupLng, {
    needsBike: trip.rideClass === 'BIKE',
  });
  if (drivers.length === 0) {
    await prisma.trip.update({ where: { id: trip.id }, data: { status: 'UNASSIGNED' } });
    io.to(`user:${trip.riderId}`).emit('trip:status-changed', { tripId: trip.id, status: 'UNASSIGNED' });
    logger.info('[Dispatch] No drivers for trip', { tripId: trip.id });
    return { offered: 0 };
  }
  await prisma.trip.update({
    where: { id: trip.id },
    data: { status: 'DRIVER_ASSIGNED', assignedAt: new Date(), dispatchAttempts: { increment: 1 } },
  });
  await prisma.tripAssignment.createMany({
    data: drivers.map((d) => ({ tripId: trip.id, driverId: d.id })),
  });
  for (const d of drivers) {
    io.to(`user:${d.userId}`).emit('trip:new-request', {
      tripId: trip.id, rideClass: trip.rideClass,
      pickup: { address: trip.pickupAddress, lat: trip.pickupLat, lng: trip.pickupLng },
      dropoff: { address: trip.dropoffAddress, lat: trip.dropoffLat, lng: trip.dropoffLng },
      fareEstimate: Number(trip.fareEstimate), distanceKm: d.distanceKm,
      expiresAt: Date.now() + OFFER_TTL_MS,
    });
  }
  logger.info('[Dispatch] Trip offered', { tripId: trip.id, drivers: drivers.length });

  // Expire offers if still unanswered.
  setTimeout(() => expireTrip(io, trip.id).catch(() => {}), OFFER_TTL_MS);
  return { offered: drivers.length };
}

async function expireTrip(io, tripId) {
  const trip = await prisma.trip.findUnique({ where: { id: tripId } });
  if (!trip || trip.status !== 'DRIVER_ASSIGNED') return;
  await prisma.trip.update({ where: { id: tripId }, data: { status: 'UNASSIGNED' } });
  await prisma.tripAssignment.updateMany({
    where: { tripId, status: 'OFFERED' }, data: { status: 'EXPIRED' },
  });
  io.to(`user:${trip.riderId}`).emit('trip:status-changed', { tripId, status: 'UNASSIGNED' });
}

// Offer a delivery order to nearby couriers.
async function dispatchOrder(io, order) {
  const drivers = await nearbyDrivers(order.pickupLat, order.pickupLng, { delivery: true });
  if (drivers.length === 0) {
    io.to(`user:${order.customerId}`).emit('order:status-changed', { orderId: order.id, status: order.status, courier: null });
    return { offered: 0 };
  }
  for (const d of drivers) {
    io.to(`user:${d.userId}`).emit('order:new-request', {
      orderId: order.id, type: order.type,
      pickup: { address: order.pickupAddress, lat: order.pickupLat, lng: order.pickupLng },
      dropoff: { address: order.dropoffAddress, lat: order.dropoffLat, lng: order.dropoffLng },
      payout: Number(order.deliveryFee), distanceKm: d.distanceKm,
      expiresAt: Date.now() + OFFER_TTL_MS,
    });
  }
  return { offered: drivers.length };
}

module.exports = { nearbyDrivers, dispatchTrip, dispatchOrder, expireTrip, RADIUS_KM };
