#!/usr/bin/env node
/**
 * reset-db.js — DESTRUCTIVE. Wipes ALL application data from the Postgres
 * database for a fresh production start. Schema + migration history are kept.
 *
 * Optionally preserves a single user row (e.g. the admin) so login access is
 * retained. That user's own transactional data (bookings, wallet, etc.) is
 * still cleared — only their identity row survives.
 *
 * Safety: refuses to run without `--confirm WIPE`.
 *
 * Usage:
 *   DATABASE_URL="<public-proxy-url>" node scripts/reset-db.js --confirm WIPE \
 *     --keep-email amoaherick2020@gmail.com
 *
 *   # wipe absolutely everything (no preserved user):
 *   DATABASE_URL="..." node scripts/reset-db.js --confirm WIPE
 */
const prisma = require('../src/config/database');

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  if (arg('--confirm') !== 'WIPE') {
    console.error('Refusing to run. Re-run with: --confirm WIPE');
    process.exit(1);
  }
  const keepEmail = arg('--keep-email') || null;

  // Counts before (evidence)
  const before = await prisma.user.count();
  console.log(`Users before: ${before}${keepEmail ? ` | preserving: ${keepEmail}` : ' | preserving: none'}`);

  await prisma.$transaction(async (tx) => {
    if (keepEmail) {
      // Snapshot the kept user into a TEMP table (lives in pg_temp schema, so it
      // is NOT in the public-schema truncate set below).
      const n = await tx.$executeRawUnsafe(
        `CREATE TEMP TABLE _keep_user AS
         SELECT * FROM public.users WHERE lower(email) = lower('${keepEmail.replace(/'/g, "''")}')`,
      );
      if (!n) {
        throw new Error(`--keep-email "${keepEmail}" matched no user; aborting to avoid wiping with no admin.`);
      }
    }

    // Truncate every public table except prisma migration history. Truncating
    // the whole FK graph in ONE statement is allowed without CASCADE.
    await tx.$executeRawUnsafe(`
      DO $$
      DECLARE s text;
      BEGIN
        SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
        INTO s FROM pg_tables
        WHERE schemaname = 'public' AND tablename <> '_prisma_migrations';
        EXECUTE 'TRUNCATE TABLE ' || s || ' RESTART IDENTITY';
      END $$;`);

    if (keepEmail) {
      await tx.$executeRawUnsafe(`INSERT INTO public.users SELECT * FROM _keep_user`);
      await tx.$executeRawUnsafe(`DROP TABLE _keep_user`);
    }
  }, { timeout: 120000, maxWait: 20000 });

  const after = await prisma.user.count();
  const bookings = await prisma.booking.count();
  console.log(`✓ Wipe complete. Users now: ${after} | bookings: ${bookings}`);
  if (keepEmail && after !== 1) console.warn(`! Expected 1 preserved user, found ${after}.`);
}

main()
  .catch((e) => { console.error('✗ Error:', e.message); process.exit(1); })
  .finally(async () => { try { await prisma.$disconnect(); } catch (_) {} });
