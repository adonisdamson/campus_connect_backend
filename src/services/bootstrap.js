// Boot-time data bootstrap. Runs on the server's own (working) DB connection, so
// it's reliable regardless of deploy start-command quirks. Idempotent.
const prisma = require('../config/database');
const logger = require('../config/logger');

// Ensure reference + demo data exists (universities, categories, coupons, demo
// vendors/services). Only runs the full seed when universities are missing, so
// normal restarts are cheap. The seed itself is idempotent.
async function ensureSeedData() {
  try {
    const unis = await prisma.university.count();
    if (unis > 0) return;
    logger.info('[Bootstrap] No universities found — seeding reference data');
    const { main } = require('../../prisma/seed');
    await main();
    logger.info('[Bootstrap] Seed complete');
  } catch (e) {
    logger.error('[Bootstrap] Seed failed', { message: e.message });
  }
}

// Promote the configured super admin (idempotent). Set SUPER_ADMIN_EMAIL in env.
async function ensureSuperAdmin() {
  const email = (process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();
  if (!email) return;
  try {
    const user = await prisma.user.findFirst({ where: { email } });
    if (user && user.role !== 'SUPER_ADMIN') {
      await prisma.user.update({ where: { id: user.id }, data: { role: 'SUPER_ADMIN' } });
      logger.info('[Bootstrap] Promoted super admin', { email });
    }
  } catch (e) {
    logger.error('[Bootstrap] ensureSuperAdmin failed', { message: e.message });
  }
}

async function runBootstrap() {
  await ensureSeedData();
  await ensureSuperAdmin();
}

module.exports = { runBootstrap, ensureSeedData, ensureSuperAdmin };
