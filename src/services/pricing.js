// Fare & fee estimation for rides and deliveries (GHS).
const { haversineKm } = require('../utils/geo');

const RIDE = {
  ECONOMY: { base: 5, perKm: 1.8, perMin: 0.15, min: 6 },
  PREMIUM: { base: 9, perKm: 3.0, perMin: 0.25, min: 12 },
  BIKE:    { base: 3, perKm: 1.2, perMin: 0.10, min: 4 },
  SHARED:  { base: 4, perKm: 1.3, perMin: 0.12, min: 5 },
};

const DELIVERY_BASE = { FOOD: 6, PARCEL: 7, SHOPPING: 8, GAS: 10 };
const DELIVERY_PER_KM = 1.5;
const SERVICE_FEE = 2; // flat platform fee

// avg campus speed ~22km/h → minutes
function estimateMinutes(km) {
  return Math.max(2, Math.round((km / 22) * 60));
}

function estimateRide(rideClass, pickup, dropoff, surge = 1.0) {
  const cfg = RIDE[rideClass] || RIDE.ECONOMY;
  const km = haversineKm(pickup.lat, pickup.lng, dropoff.lat, dropoff.lng);
  const mins = estimateMinutes(km);
  let fare = cfg.base + km * cfg.perKm + mins * cfg.perMin;
  fare = Math.max(fare, cfg.min) * surge;
  return {
    distanceMeters: Math.round(km * 1000),
    durationSeconds: mins * 60,
    fareEstimate: round2(fare),
    surgeMultiplier: surge,
  };
}

function estimateDelivery(type, pickup, dropoff) {
  const km = haversineKm(pickup.lat, pickup.lng, dropoff.lat, dropoff.lng);
  const deliveryFee = round2((DELIVERY_BASE[type] || 6) + km * DELIVERY_PER_KM);
  return { distanceKm: round2(km), deliveryFee, serviceFee: SERVICE_FEE };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { estimateRide, estimateDelivery, estimateMinutes, SERVICE_FEE, round2 };
