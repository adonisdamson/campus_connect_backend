// JWT access/refresh token helpers.
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const prisma = require('../config/database');
const { JWT_SECRET } = require('../config/env');

const ACCESS_TTL = '15m';
const REFRESH_TTL_DAYS = 30;

// Refresh tokens are opaque random strings. We never store the raw value — only
// its SHA-256 digest — so a leaked DB row can't be replayed as a session.
function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function signAccess(user) {
  return jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: ACCESS_TTL });
}

async function issueRefresh(userId) {
  const raw = crypto.randomBytes(48).toString('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({ data: { token: hashToken(raw), userId, expiresAt } });
  return raw; // caller returns this to the client; only the hash is persisted
}

async function rotateRefresh(rawOld) {
  const hash = hashToken(rawOld);
  const existing = await prisma.refreshToken.findUnique({ where: { token: hash } });
  if (!existing || existing.expiresAt < new Date()) return null;
  // Single-use: consume the old token before minting a new one.
  await prisma.refreshToken.delete({ where: { token: hash } }).catch(() => {});
  const fresh = await issueRefresh(existing.userId);
  return { userId: existing.userId, refreshToken: fresh };
}

async function revokeRefresh(rawToken) {
  if (!rawToken) return;
  await prisma.refreshToken.deleteMany({ where: { token: hashToken(rawToken) } });
}

// Issue both tokens for a user.
async function issueSession(user) {
  const accessToken = signAccess(user);
  const refreshToken = await issueRefresh(user.id);
  return { accessToken, refreshToken };
}

module.exports = { signAccess, issueRefresh, rotateRefresh, revokeRefresh, issueSession };
