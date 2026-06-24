// Demand-based surge — more open ride requests than nearby online drivers pushes
// the multiplier up. Bounded to [1.0, 2.5].
const prisma = require('../config/database');
const { haversineKm } = require('../utils/geo');

const RADIUS_KM = 8;

async function computeSurge(lat, lng) {
  if (lat == null || lng == null) return 1.0;

  const [drivers, openTrips] = await Promise.all([
    prisma.driverProfile.findMany({
      where: { isOnline: true, status: 'ACTIVE', doesRides: true, currentLat: { not: null } },
      select: { currentLat: true, currentLng: true },
    }),
    prisma.trip.findMany({
      where: { status: { in: ['SEARCHING', 'DRIVER_ASSIGNED'] } },
      select: { pickupLat: true, pickupLng: true },
    }),
  ]);

  const near = (items, a, b) => items.filter((i) => haversineKm(lat, lng, i[a], i[b]) <= RADIUS_KM).length;
  const supply = near(drivers, 'currentLat', 'currentLng');
  const demand = near(openTrips, 'pickupLat', 'pickupLng');

  if (supply === 0) return demand > 0 ? 1.8 : 1.0;
  const ratio = demand / supply;
  const surge = 1 + Math.max(0, ratio - 0.5) * 0.8;
  return Math.min(2.5, Math.round(surge * 10) / 10);
}

module.exports = { computeSurge };
