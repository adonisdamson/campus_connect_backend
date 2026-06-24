const jwt = require('jsonwebtoken');
const prisma = require('../config/database');
const { LRUCache } = require('lru-cache');
const logger = require('../config/logger');
const { JWT_SECRET } = require('../config/env');

// Cache user objects for 60 seconds to reduce DB load at scale.
// Max 1000 users in memory.
const userCache = new LRUCache({
  max: 1000,
  ttl: 1000 * 60, 
});

function evictUserCache(userId) {
  if (userId) userCache.delete(userId);
}

async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    
    // 1. Check cache first
    let user = userCache.get(payload.userId);

    if (!user) {
      // 2. Fallback to DB
      user = await prisma.user.findUnique({ where: { id: payload.userId } });
      if (user) {
        userCache.set(payload.userId, user);
      }
    }

    if (!user) return res.status(401).json({ success: false, error: 'User not found' });
    if (user.status === 'SUSPENDED') {
      return res.status(403).json({ success: false, error: 'Account suspended' });
    }
    if (user.status === 'BANNED') {
      return res.status(403).json({ success: false, error: 'Account banned' });
    }
    
    req.user = user;
    logger.updateContext({
      userId: user.id,
      collectorId: user.role === 'COLLECTOR' ? user.id : undefined,
    });
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }
    next();
  };
}

// Admin area gate. SUPER_ADMIN passes everything; ADMIN passes only if the
// permission key is in their adminPermissions list. Everyone else is denied.
function requirePermission(permission) {
  return (req, res, next) => {
    const u = req.user;
    if (u.role === 'SUPER_ADMIN') return next();
    if (u.role === 'ADMIN') {
      const perms = Array.isArray(u.adminPermissions) ? u.adminPermissions : [];
      if (perms.includes(permission)) return next();
    }
    return res.status(403).json({ success: false, error: 'You do not have access to this area' });
  };
}

module.exports = { authenticate, requireRole, requirePermission, evictUserCache };
