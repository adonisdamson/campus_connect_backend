// Campus Connect API server.
require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const { Prisma } = require('@prisma/client');

const logger = require('./config/logger');
const { corsOrigins } = require('./config/env');
const prisma = require('./config/database');
const errorHandler = require('./middleware/errorHandler');
const { initSocket } = require('./socket');
const apiRoutes = require('./routes');

process.on('unhandledRejection', (reason) => {
  logger.error('[Process] Unhandled rejection', { message: reason?.message || String(reason) });
});
process.on('uncaughtException', (err) => {
  logger.error('[Process] Uncaught exception', { message: err.message, stack: err.stack });
});

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: corsOrigins, methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  pingInterval: 15000,
  pingTimeout: 10000,
});
app.set('io', io);
app.set('trust proxy', 1);

// Serialise Prisma Decimal as JS numbers for mobile clients.
app.set('json replacer', (_k, v) => (Prisma.Decimal.isDecimal(v) ? parseFloat(v.toString()) : v));

app.use(helmet());
app.use(cors({ origin: corsOrigins }));
// Keep the raw body around so the Paystack webhook can verify its HMAC against
// the exact bytes Paystack signed (JSON.stringify of the parsed body won't match).
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Health
app.get('/health', async (req, res) => {
  let db = 'down';
  try { await prisma.$queryRaw`SELECT 1`; db = 'up'; } catch (_) {}
  res.json({ success: true, service: 'campus-connect-api', db, sockets: io.engine.clientsCount, time: new Date().toISOString() });
});

// Serve uploaded media (KYC docs, photos). Files are random-named; access to the
// API that returns these URLs is already authenticated.
app.use('/uploads', express.static(require('path').join(__dirname, '../uploads'), {
  maxAge: '7d', index: false, dotfiles: 'deny',
}));

// API
app.use('/api/v1', apiRoutes);

// 404 + errors
app.use((req, res) => res.status(404).json({ success: false, error: 'Not found' }));
app.use(errorHandler);

initSocket(io);

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  httpServer.listen(PORT, () => logger.info(`[Server] Campus Connect API on :${PORT}`));
}

module.exports = { app, httpServer, io };
