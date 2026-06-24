// Centralised, fail-fast environment configuration.
// One source of truth for secrets so signing/verification can never drift, and
// so the server refuses to boot insecurely in production.
const logger = require('./logger');

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';
const isTest = NODE_ENV === 'test';

// Insecure fallback used ONLY outside production so local dev/tests work without
// a .env. The moment NODE_ENV=production, every secret must be supplied.
const DEV_FALLBACK_SECRET = 'dev_only_insecure_secret_do_not_use_in_prod';

function die(message) {
  logger.error(`[Config] ${message}`);
  // Fail fast — a misconfigured production server is worse than no server.
  process.exit(1);
}

function requireSecret(name, { minLength = 16 } = {}) {
  let value = process.env[name];
  if (!value) {
    if (isProd) die(`${name} is required in production. Refusing to start.`);
    logger.warn(`[Config] ${name} not set — using insecure dev fallback. DO NOT ship this.`);
    return DEV_FALLBACK_SECRET;
  }
  if (isProd && value.length < minLength) {
    die(`${name} must be at least ${minLength} characters in production.`);
  }
  return value;
}

const JWT_SECRET = requireSecret('JWT_SECRET', { minLength: 32 });

// CORS / realtime origins. In production we refuse the wildcard.
function resolveCorsOrigins() {
  const raw = (process.env.FRONTEND_URL || '').trim();
  if (!raw || raw === '*') {
    if (isProd) die('FRONTEND_URL must list explicit origin(s) in production (no "*").');
    return '*';
  }
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

const corsOrigins = resolveCorsOrigins();

// Guest sign-in is a dev convenience; off by default in production.
const allowGuest = !isProd || process.env.ALLOW_GUEST === 'true';

module.exports = { NODE_ENV, isProd, isTest, JWT_SECRET, corsOrigins, allowGuest };
