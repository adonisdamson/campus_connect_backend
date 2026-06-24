// Geo — server-side search (geocoding) + routing so the TomTom key never leaves
// the backend. Provider chain mirrors the app's old client logic:
//   search:  TomTom → Photon (free)
//   route:   TomTom → OSRM (free) → straight line
const { asyncHandler, ok, fail } = require('../utils/http');
const logger = require('../config/logger');

const TOMTOM = process.env.TOMTOM_API_KEY || '';
const PILOT = { lat: 5.301, lng: -1.996 }; // UMaT, Tarkwa

function num(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }

async function tomtomSearch(q, lat, lng) {
  const url = `https://api.tomtom.com/search/2/search/${encodeURIComponent(q)}.json`
    + `?key=${TOMTOM}&limit=8&countrySet=GH&lat=${lat}&lon=${lng}&radius=50000`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('tomtom search ' + r.status);
  const d = await r.json();
  return (d.results || []).map((x) => {
    const poi = x.poi?.name;
    const addr = x.address?.freeformAddress;
    return { name: poi ? `${poi} — ${addr || ''}`.trim() : (addr || 'Unknown place'), lat: x.position.lat, lng: x.position.lon };
  });
}

async function photonSearch(q, lat, lng) {
  const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=8&lat=${lat}&lon=${lng}`);
  if (!r.ok) throw new Error('photon ' + r.status);
  const d = await r.json();
  return (d.features || []).map((f) => {
    const c = f.geometry.coordinates; // [lng, lat]
    const p = f.properties || {};
    const name = [p.name, p.street, p.city, p.country].filter(Boolean).join(', ');
    return { name: name || 'Location', lat: c[1], lng: c[0] };
  });
}

// GET /geo/search?q=&lat=&lng=
exports.search = asyncHandler(async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return ok(res, { places: [] });
  const lat = num(req.query.lat, PILOT.lat);
  const lng = num(req.query.lng, PILOT.lng);
  let places = [];
  if (TOMTOM) { try { places = await tomtomSearch(q, lat, lng); } catch (e) { logger.warn('[Geo] tomtom search failed', { m: e.message }); } }
  if (!places.length) { try { places = await photonSearch(q, lat, lng); } catch (e) { logger.warn('[Geo] photon failed', { m: e.message }); } }
  return ok(res, { places });
});

async function tomtomRoute(a, b) {
  const url = `https://api.tomtom.com/routing/1/calculateRoute/${a.lat},${a.lng}:${b.lat},${b.lng}/json`
    + `?key=${TOMTOM}&travelMode=car&routeType=fastest`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('tomtom route ' + r.status);
  const d = await r.json();
  const route = d.routes[0];
  const points = [];
  for (const leg of route.legs) for (const p of leg.points) points.push({ lat: p.latitude, lng: p.longitude });
  return { points, distanceMeters: route.summary.lengthInMeters, durationSeconds: route.summary.travelTimeInSeconds };
}

async function osrmRoute(a, b) {
  const url = `https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('osrm ' + r.status);
  const d = await r.json();
  const route = d.routes[0];
  const points = route.geometry.coordinates.map((c) => ({ lat: c[1], lng: c[0] }));
  return { points, distanceMeters: route.distance, durationSeconds: route.duration };
}

function straightLine(a, b) {
  const R = 6371000, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  const meters = R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return { points: [a, b], distanceMeters: meters, durationSeconds: meters / 6.1 };
}

// GET /geo/route?fromLat=&fromLng=&toLat=&toLng=
exports.route = asyncHandler(async (req, res) => {
  const a = { lat: num(req.query.fromLat, null), lng: num(req.query.fromLng, null) };
  const b = { lat: num(req.query.toLat, null), lng: num(req.query.toLng, null) };
  if ([a.lat, a.lng, b.lat, b.lng].some((v) => v == null)) fail(400, 'from/to coordinates required');
  if (TOMTOM) { try { return ok(res, await tomtomRoute(a, b)); } catch (_) {} }
  try { return ok(res, await osrmRoute(a, b)); } catch (_) {}
  return ok(res, straightLine(a, b));
});
