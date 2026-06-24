#!/usr/bin/env node
/**
 * make-admin.js — promote (or demote) a Campus Connect user to ADMIN by email or phone.
 *
 * Usage:
 *   npm run make-admin -- <email-or-phone>            # promote to ADMIN
 *   npm run make-admin -- <email-or-phone> --demote   # back to USER
 *
 * Reads DATABASE_URL from the environment. The target account must already
 * exist (register it in the app first).
 */
const prisma = require('../src/config/database');

async function main() {
  const ident = process.argv[2];
  const demote = process.argv.includes('--demote');

  if (!ident || ident.startsWith('--')) {
    console.error('Usage: npm run make-admin -- <email-or-phone> [--demote]');
    process.exit(1);
  }

  const where = ident.includes('@')
    ? { email: { equals: ident, mode: 'insensitive' } }
    : { phone: ident };

  const user = await prisma.user.findFirst({ where });
  if (!user) {
    console.error(`✗ No user found for "${ident}". Register the account in the app first, then re-run.`);
    process.exit(2);
  }

  const targetRole = demote ? 'USER' : 'ADMIN';
  if (user.role === targetRole) {
    console.log(`• ${user.email || user.phone} is already ${targetRole} (no change).`);
    return;
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { role: targetRole, status: 'ACTIVE' },
    select: { id: true, email: true, phone: true, role: true, status: true },
  });

  console.log(`✓ ${updated.email || updated.phone || updated.id} is now ${updated.role} (status ${updated.status}).`);
  console.log('  Sign out and back in on the Admin app to load the dashboard.');
}

main()
  .catch((e) => { console.error('✗ Error:', e.message); process.exit(1); })
  .finally(async () => { try { await prisma.$disconnect(); } catch (_) {} });
