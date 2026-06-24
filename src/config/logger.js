const { AsyncLocalStorage } = require('async_hooks');
const winston = require('winston');

const contextStore = new AsyncLocalStorage();

function getContext() {
  return contextStore.getStore() || {};
}

function updateContext(patch = {}) {
  const store = getContext();
  Object.assign(store, patch);
}

function withContext(context, fn) {
  const current = getContext();
  return contextStore.run({ ...current, ...context }, fn);
}

const attachContext = winston.format((info) => {
  const context = getContext();
  const merged = {
    timestamp: info.timestamp,
    level: String(info.level || 'info').toUpperCase(),
    requestId: info.requestId || context.requestId || null,
    bookingId: info.bookingId || context.bookingId || null,
    collectorId: info.collectorId || context.collectorId || null,
    userId: info.userId || context.userId || null,
  };

  info.requestId = merged.requestId;
  info.bookingId = merged.bookingId;
  info.collectorId = merged.collectorId;
  info.userId = merged.userId;
  info.level = merged.level;
  return info;
});

const devFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  attachContext(),
  winston.format.colorize({ all: true }),
  winston.format.printf(({ timestamp, level, message, requestId, userId, collectorId, bookingId, stack }) => {
    const tags = [
      requestId ? `requestId=${requestId}` : null,
      userId ? `userId=${userId}` : null,
      collectorId ? `collectorId=${collectorId}` : null,
      bookingId ? `bookingId=${bookingId}` : null,
    ].filter(Boolean).join(' ');
    return stack
      ? `${timestamp} ${level} ${tags} ${message}\n${stack}`.trim()
      : `${timestamp} ${level} ${tags} ${message}`.trim();
  })
);

const prodFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  attachContext(),
  winston.format.json()
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: process.env.NODE_ENV === 'production' ? prodFormat : devFormat,
  transports: [new winston.transports.Console()],
});

module.exports = logger;
module.exports.getContext = getContext;
module.exports.updateContext = updateContext;
module.exports.withContext = withContext;
