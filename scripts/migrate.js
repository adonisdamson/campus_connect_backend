/**
 * scripts/migrate.js
 *
 * Startup migration shim for Railway deployments.
 *
 * The Railway database was originally bootstrapped via `prisma db push`.
 * Switching to `prisma migrate deploy` requires that the _prisma_migrations
 * table exists and the baseline migration is recorded as already applied,
 * otherwise Prisma would try to re-run the baseline CREATE TABLE statements
 * against a database that already has those tables.
 *
 * What this script does on every boot:
 *   1. Creates the _prisma_migrations table if it does not exist.
 *   2. Marks the baseline migration as applied if it is not already recorded.
 *   3. Runs `prisma migrate deploy` — Prisma will only apply migrations that
 *      are not yet in _prisma_migrations (i.e., the hardening delta and any
 *      future migrations).
 *
 * On a fresh database (no tables at all):
 *   - _prisma_migrations is created.
 *   - Baseline is NOT pre-marked → `prisma migrate deploy` runs it (creates all tables).
 *   - Hardening delta runs next.
 *
 * On the existing Railway database (tables from db push):
 *   - _prisma_migrations is created.
 *   - Baseline is pre-marked as applied (tables already exist).
 *   - Hardening delta runs (adds dispatchAttempts, online_sessions, indexes).
 */

'use strict';

const { execSync }   = require('child_process');
const { PrismaClient } = require('@prisma/client');

const BASELINE_NAME = '20260604000000_baseline';

async function main() {
  const prisma = new PrismaClient();

  try {
    // Step 1: Create _prisma_migrations table if absent
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
        id                   VARCHAR(36)  NOT NULL,
        checksum             VARCHAR(64)  NOT NULL,
        finished_at          TIMESTAMPTZ,
        migration_name       VARCHAR(255) NOT NULL,
        logs                 TEXT,
        rolled_back_at       TIMESTAMPTZ,
        started_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
        applied_steps_count  INTEGER      NOT NULL DEFAULT 0,
        CONSTRAINT "_prisma_migrations_pkey" PRIMARY KEY (id)
      )
    `;

    // Step 2: Check whether the database already has the users table (indicates
    // it was previously bootstrapped via db push).
    const tables = await prisma.$queryRaw`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename = 'users'
      LIMIT 1
    `;
    const dbAlreadyExists = Array.isArray(tables) && tables.length > 0;

    if (dbAlreadyExists) {
      // Check if baseline is already recorded in migration history
      const existing = await prisma.$queryRaw`
        SELECT id FROM "_prisma_migrations"
        WHERE migration_name = ${BASELINE_NAME}
        LIMIT 1
      `;

      if (!Array.isArray(existing) || existing.length === 0) {
        // Mark baseline as applied — tables already exist from db push
        await prisma.$executeRaw`
          INSERT INTO "_prisma_migrations"
            (id, checksum, finished_at, migration_name, logs, applied_steps_count)
          VALUES (
            gen_random_uuid()::varchar,
            'baseline-pre-applied',
            NOW(),
            ${BASELINE_NAME},
            'Pre-marked as applied: database was bootstrapped via prisma db push',
            1
          )
        `;
        console.log('[migrate] Baseline marked as applied (pre-existing database detected).');
      } else {
        console.log('[migrate] Baseline already recorded — skipping pre-mark.');
      }
    } else {
      console.log('[migrate] Fresh database detected — baseline will be applied by prisma migrate deploy.');
    }

    // Step 3: Clear any stuck/failed migrations so they are re-attempted.
    // A stuck migration has finished_at IS NULL and rolled_back_at IS NULL
    // (Prisma left it partial after a crash). Delete it so migrate deploy retries.
    const stuck = await prisma.$queryRaw`
      SELECT id, migration_name FROM "_prisma_migrations"
      WHERE finished_at IS NULL
        AND rolled_back_at IS NULL
        AND started_at < NOW() - INTERVAL '2 minutes'
    `;
    if (Array.isArray(stuck) && stuck.length > 0) {
      for (const m of stuck) {
        await prisma.$executeRaw`DELETE FROM "_prisma_migrations" WHERE id = ${m.id}`;
        console.log('[migrate] Cleared stuck migration: ' + m.migration_name);
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  // Step 4: Run pending migrations
  console.log('[migrate] Running prisma migrate deploy…');
  execSync('npx prisma migrate deploy', { stdio: 'inherit' });
  console.log('[migrate] Migration complete.');
}

main().catch((err) => {
  console.error('[migrate] Fatal error:', err.message);
  process.exit(1);
});
