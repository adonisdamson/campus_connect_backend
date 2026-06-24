const logger = require('../config/logger');

function errorHandler(err, req, res, _next) {
  logger.error(`[Error] ${req.method} ${req.originalUrl} — ${err.message}`, {
    stack: err.stack,
    requestId: req.requestId,
    userId: req.user?.id,
    bookingId: req.params?.id || req.body?.bookingId || null,
    collectorId: req.user?.role === 'COLLECTOR' ? req.user.id : null,
  });

  // Prisma known errors → 4xx
  if (err.code === 'P2002') {
    return res.status(409).json({ success: false, error: 'Record already exists' });
  }
  if (err.code === 'P2025') {
    return res.status(404).json({ success: false, error: 'Record not found' });
  }

  const status = err.status || err.statusCode || 500;
  // Never leak internal details to callers for 5xx
  const message = status < 500 ? err.message : 'Internal server error';
  res.status(status).json({ success: false, error: message });
}

module.exports = errorHandler;
