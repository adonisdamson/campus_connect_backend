const { PrismaClient } = require('@prisma/client');
const logger = require('./logger');
const { getContext } = require('./logger');

const prisma = new PrismaClient({
  log: [
    ...(process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error']),
    { emit: 'event', level: 'query' },
  ],
});

prisma.$on('query', (event) => {
  if (event.duration <= 500) return;
  const context = getContext();
  logger.warn('Slow query detected', {
    requestId: context.requestId || null,
    route: context.route || null,
    durationMs: event.duration,
    sql: event.query,
  });
});

module.exports = prisma;
