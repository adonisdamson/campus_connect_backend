// Auth — email/password, Google (Firebase), phone OTP, guest, refresh.
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../config/database');
const logger = require('../config/logger');
const { asyncHandler, fail, ok } = require('../utils/http');
const { issueSession, rotateRefresh, revokeRefresh, signAccess } = require('../utils/token');
const { allowGuest } = require('../config/env');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Public-safe user shape returned to clients.
function publicUser(u) {
  return {
    id: u.id, email: u.email, phone: u.phone, fullName: u.fullName,
    profilePhoto: u.profilePhoto, campusRole: u.campusRole, role: u.role,
    status: u.status, isVerified: u.isVerified,
    isDriver: u.isDriver, isVendor: u.isVendor, isServiceProvider: u.isServiceProvider,
    rating: u.rating, referralCode: u.referralCode, universityId: u.universityId,
  };
}

async function ensureWallet(userId) {
  await prisma.wallet.upsert({ where: { userId }, update: {}, create: { userId } });
}

function genReferral() {
  return 'CC' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

// POST /auth/register
exports.register = asyncHandler(async (req, res) => {
  const { email, password, fullName, phone, campusRole, referredBy, universityId } = req.body;
  if (!email || !password) fail(400, 'Email and password are required');
  if (!EMAIL_RE.test(String(email))) fail(400, 'Enter a valid email address');
  if (password.length < 8) fail(400, 'Password must be at least 8 characters');

  const existing = await prisma.user.findFirst({
    where: { OR: [{ email }, phone ? { phone } : undefined].filter(Boolean) },
  });
  if (existing) fail(409, 'An account with that email or phone already exists');

  let referredById = null;
  if (referredBy) {
    const referrer = await prisma.user.findUnique({ where: { referralCode: referredBy } });
    referredById = referrer?.id || null;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: {
      email, phone, fullName, passwordHash,
      campusRole: campusRole || 'STUDENT',
      universityId: universityId || null,
      referralCode: genReferral(),
      referredById,
    },
  });
  await ensureWallet(user.id);

  const tokens = await issueSession(user);
  logger.info('[Auth] Registered', { userId: user.id });
  return ok(res, { user: publicUser(user), ...tokens }, 201);
});

// POST /auth/login
exports.login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) fail(400, 'Email and password are required');

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash) fail(401, 'Invalid credentials');
  if (user.status === 'BANNED') fail(403, 'This account has been banned');

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) fail(401, 'Invalid credentials');

  await ensureWallet(user.id);
  const tokens = await issueSession(user);
  return ok(res, { user: publicUser(user), ...tokens });
});

// POST /auth/google  { idToken } — verifies a Firebase ID token
exports.google = asyncHandler(async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) fail(400, 'idToken is required');

  let decoded;
  try {
    const { getFirebaseApp, admin } = require('../config/firebase');
    const app = getFirebaseApp();
    if (!app) fail(503, 'Google sign-in is not configured on this server');
    decoded = await admin.auth(app).verifyIdToken(idToken);
  } catch (e) {
    if (e.status) throw e;
    fail(401, 'Invalid Google token');
  }

  let user = await prisma.user.findFirst({
    where: { OR: [{ firebaseUid: decoded.uid }, decoded.email ? { email: decoded.email } : undefined].filter(Boolean) },
  });
  if (!user) {
    user = await prisma.user.create({
      data: {
        firebaseUid: decoded.uid, email: decoded.email || null,
        fullName: decoded.name || null, profilePhoto: decoded.picture || null,
        isVerified: !!decoded.email_verified, referralCode: genReferral(),
      },
    });
  } else if (!user.firebaseUid) {
    user = await prisma.user.update({ where: { id: user.id }, data: { firebaseUid: decoded.uid } });
  }
  await ensureWallet(user.id);
  const tokens = await issueSession(user);
  return ok(res, { user: publicUser(user), ...tokens });
});

// POST /auth/otp/request  { phone }
exports.requestOtp = asyncHandler(async (req, res) => {
  const { phone } = req.body;
  if (!phone) fail(400, 'Phone is required');
  const otp = '' + Math.floor(100000 + Math.random() * 900000);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  await prisma.otpRecord.create({ data: { phone, otp, purpose: 'LOGIN', expiresAt } });

  logger.info('[Auth] OTP issued', { phone });
  const payload = { message: 'OTP sent' };
  if (process.env.NODE_ENV !== 'production') payload.devOtp = otp;
  return ok(res, payload);
});

// POST /auth/otp/verify  { phone, otp, fullName? }
exports.verifyOtp = asyncHandler(async (req, res) => {
  const { phone, otp, fullName } = req.body;
  if (!phone || !otp) fail(400, 'Phone and otp are required');

  const record = await prisma.otpRecord.findFirst({
    where: { phone, otp, used: false, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!record) fail(401, 'Invalid or expired OTP');
  await prisma.otpRecord.update({ where: { id: record.id }, data: { used: true } });

  let user = await prisma.user.findUnique({ where: { phone } });
  if (!user) {
    user = await prisma.user.create({ data: { phone, fullName, isVerified: true, referralCode: genReferral() } });
  }
  await ensureWallet(user.id);
  const tokens = await issueSession(user);
  return ok(res, { user: publicUser(user), ...tokens });
});

// POST /auth/guest
exports.guest = asyncHandler(async (req, res) => {
  if (!allowGuest) fail(403, 'Guest access is disabled');
  const user = await prisma.user.create({
    data: { fullName: 'Guest', campusRole: 'NON_STUDENT', referralCode: genReferral() },
  });
  const tokens = await issueSession(user);
  return ok(res, { user: publicUser(user), ...tokens, guest: true }, 201);
});

// POST /auth/refresh  { refreshToken }
exports.refresh = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) fail(400, 'refreshToken is required');
  const rotated = await rotateRefresh(refreshToken);
  if (!rotated) fail(401, 'Invalid or expired refresh token');
  const user = await prisma.user.findUnique({ where: { id: rotated.userId } });
  if (!user) fail(401, 'User not found');
  return ok(res, { accessToken: signAccess(user), refreshToken: rotated.refreshToken });
});

// POST /auth/logout  { refreshToken }
exports.logout = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  await revokeRefresh(refreshToken);
  return ok(res, { message: 'Logged out' });
});

// GET /auth/me
exports.me = asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  return ok(res, { user: publicUser(user) });
});

exports.publicUser = publicUser;
