/**
 * dispatch_sim.js — Offline simulation of the 10-factor dispatch engine.
 *
 * Runs scoreCollector() for 3 representative collectors with realistic mock data
 * and prints a factor-by-factor breakdown to demonstrate before/after behaviour.
 *
 * No database connection required.
 *
 * Usage:  node scripts/dispatch_sim.js
 */

const { scoreCollector } = require('../src/services/dispatchService');

// ── Booking being dispatched ──────────────────────────────────────────────
const booking = {
  binSize:    'MEDIUM',   // 90 kg equivalent
  pickupLat:  5.6037,
  pickupLng: -0.1870,
};

// ── Three representative collector profiles ───────────────────────────────

// Collector A: close, great rating, experienced, responsive
const collectorA = {
  id: 'collector-a',
  distanceKm:    1.2,
  rating:        4.8,
  totalPickups:  87,
  currentLoadKg: 80,
  maxCapacityKg: 500,
  lastSeenAt:    new Date(Date.now() - 90 * 60 * 1000), // 90 min ago
};
const statsA = {
  completionRate:      0.96,   // 96% of jobs completed
  consecutiveDeclines: 0,       // clean streak
  avgResponseSec:      28,      // fast responder (28s avg)
  pickupsInZone:       12,      // very familiar with this area
  onlineHoursToday:    5.5,     // been working all morning
  isPriority:          false,
};

// Collector B: medium distance, average rating, serial decliner
const collectorB = {
  id: 'collector-b',
  distanceKm:    5.4,
  rating:        3.9,
  totalPickups:  31,
  currentLoadKg: 410,
  maxCapacityKg: 500,
  lastSeenAt:    new Date(Date.now() - 45 * 60 * 1000), // 45 min ago
};
const statsB = {
  completionRate:      0.71,   // only 71% completion
  consecutiveDeclines: 3,       // declined last 3 in a row
  avgResponseSec:      95,      // slow to respond
  pickupsInZone:       2,       // not familiar with area
  onlineHoursToday:    2.0,
  isPriority:          false,
};

// Collector C: far, but new (no history), admin-flagged priority
const collectorC = {
  id: 'collector-c',
  distanceKm:    11.0,
  rating:        5.0,          // default (no reviews yet)
  totalPickups:  3,
  currentLoadKg: 0,
  maxCapacityKg: 500,
  lastSeenAt:    new Date(Date.now() - 20 * 60 * 1000), // 20 min ago
};
const statsC = {
  completionRate:      null,   // new collector — will use totalPickups proxy
  consecutiveDeclines: 0,
  avgResponseSec:      null,   // no history — neutral 0.5
  pickupsInZone:       0,
  onlineHoursToday:    0.5,
  isPriority:          true,   // admin override
};

// ── BEFORE scores (no statsMap — default/neutral values) ─────────────────

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  DISPATCH SIMULATION — Booking: MEDIUM bin @ Accra (5.60°N)');
console.log('══════════════════════════════════════════════════════════════\n');

console.log('─── BEFORE FIX (statsMap = empty, all stats default) ─────────\n');

const beforeA = scoreCollector(collectorA, booking, {});
const beforeB = scoreCollector(collectorB, booking, {});
const beforeC = scoreCollector(collectorC, booking, {});

printBreakdown('Collector A', beforeA, collectorA);
printBreakdown('Collector B', beforeB, collectorB);
printBreakdown('Collector C', beforeC, collectorC);

const beforeRanking = [
  { name: 'A', score: beforeA.score },
  { name: 'B', score: beforeB.score },
  { name: 'C', score: beforeC.score },
].sort((a, b) => b.score - a.score);

console.log('BEFORE ranking:', beforeRanking.map((r) => `${r.name}(${r.score.toFixed(4)})`).join(' > '), '\n');

// ── AFTER scores (fully populated statsMap) ───────────────────────────────

console.log('─── AFTER FIX (statsMap fully populated from DB) ─────────────\n');

const afterA = scoreCollector(collectorA, booking, statsA);
const afterB = scoreCollector(collectorB, booking, statsB);
const afterC = scoreCollector(collectorC, booking, statsC);

printBreakdown('Collector A', afterA, collectorA);
printBreakdown('Collector B', afterB, collectorB);
printBreakdown('Collector C', afterC, collectorC);

const afterRanking = [
  { name: 'A', score: afterA.score },
  { name: 'B', score: afterB.score },
  { name: 'C', score: afterC.score },
].sort((a, b) => b.score - a.score);

console.log('AFTER ranking:', afterRanking.map((r) => `${r.name}(${r.score.toFixed(4)})`).join(' > '), '\n');

// ── Delta ─────────────────────────────────────────────────────────────────

console.log('─── SCORE DELTA ──────────────────────────────────────────────\n');
console.log(`Collector A:  ${beforeA.score.toFixed(4)} → ${afterA.score.toFixed(4)}  (${delta(beforeA.score, afterA.score)})`);
console.log(`Collector B:  ${beforeB.score.toFixed(4)} → ${afterB.score.toFixed(4)}  (${delta(beforeB.score, afterB.score)})`);
console.log(`Collector C:  ${beforeC.score.toFixed(4)} → ${afterC.score.toFixed(4)}  (${delta(beforeC.score, afterC.score)})`);
console.log();

const beforeWinner = beforeRanking[0].name;
const afterWinner  = afterRanking[0].name;
if (beforeWinner !== afterWinner) {
  console.log(`⚡ Ranking CHANGED: ${beforeWinner} → ${afterWinner} wins with full stats`);
} else {
  console.log(`Winner unchanged: Collector ${beforeWinner} still top.`);
}
console.log();

// ── Helper functions ──────────────────────────────────────────────────────

function printBreakdown(label, result, collector) {
  const W = { distance: 0.30, rating: 0.20, completionRate: 0.15, capacityMatch: 0.10,
               idleDelta: 0.08, rejectPenalty: 0.07, zoneFamiliarity: 0.05,
               responseTime: 0.03, onlineDuration: 0.01, priorityFlag: 0.01 };
  console.log(`${label}  (dist=${collector.distanceKm}km  rating=${collector.rating}  pickups=${collector.totalPickups})`);
  console.log(`  ${'Factor'.padEnd(18)} ${'Raw'.padStart(6)}  ${'Weight'.padStart(6)}  ${'Weighted'.padStart(8)}`);
  for (const [factor, weight] of Object.entries(W)) {
    const raw = result.breakdown[factor] ?? 0;
    console.log(`  ${factor.padEnd(18)} ${raw.toFixed(4).padStart(6)}  ${weight.toFixed(2).padStart(6)}  ${(raw * weight).toFixed(4).padStart(8)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(18)}                    ${result.score.toFixed(4).padStart(8)}`);
  console.log();
}

function delta(before, after) {
  const d = after - before;
  const sign = d >= 0 ? '+' : '';
  return `${sign}${d.toFixed(4)}`;
}
