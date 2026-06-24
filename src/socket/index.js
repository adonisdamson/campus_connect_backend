// Campus Connect realtime — presence, live location, dispatch acks, chat.
const jwt = require('jsonwebtoken');
const prisma = require('../config/database');
const logger = require('../config/logger');
const { JWT_SECRET } = require('../config/env');

function initSocket(io) {
  // Authenticate every socket via the same access token.
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('No token'));
      const payload = jwt.verify(token, JWT_SECRET);
      const user = await prisma.user.findUnique({ where: { id: payload.userId } });
      if (!user) return next(new Error('User not found'));
      if (user.status === 'SUSPENDED' || user.status === 'BANNED') return next(new Error('Account disabled'));
      socket.user = user;
      next();
    } catch (e) {
      next(new Error('Auth failed'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.user;
    socket.join(`user:${user.id}`);
    logger.info('[Socket] connected', { userId: user.id });

    // ── Driver presence ──
    socket.on('driver:go-online', async ({ lat, lng } = {}) => {
      const dp = await prisma.driverProfile.findUnique({ where: { userId: user.id } });
      if (!dp) return socket.emit('error', { message: 'Not a driver' });
      // Approval gate: only verified (admin-approved) drivers may go online.
      // `status` is the lifecycle state set by verification review — never here.
      if (dp.status !== 'ACTIVE') {
        return socket.emit('error', { code: 'NOT_VERIFIED', message: 'Driver account pending verification approval' });
      }
      await prisma.driverProfile.update({
        where: { id: dp.id },
        data: { isOnline: true, lastSeenAt: new Date(), ...(lat != null ? { currentLat: lat, currentLng: lng } : {}) },
      });
      socket.join('drivers');
      socket.emit('driver:status', { isOnline: true });
    });

    socket.on('driver:go-offline', async () => {
      const dp = await prisma.driverProfile.findUnique({ where: { userId: user.id } });
      if (dp) await prisma.driverProfile.update({ where: { id: dp.id }, data: { isOnline: false } });
      socket.leave('drivers');
      socket.emit('driver:status', { isOnline: false });
    });

    // ── Live location: persist + relay to the rider/customer watching ──
    socket.on('driver:location', async ({ lat, lng, bearing, tripId, orderId } = {}) => {
      if (lat == null || lng == null) return;
      const dp = await prisma.driverProfile.findUnique({ where: { userId: user.id } });
      if (dp) {
        await prisma.driverProfile.update({
          where: { id: dp.id }, data: { currentLat: lat, currentLng: lng, bearing, lastSeenAt: new Date() },
        }).catch(() => {});
      }
      // Only relay a position to the rider/customer if THIS user is the trip's
      // assigned driver / the order's assigned courier. Otherwise an attacker
      // could spoof a driver's location on any trip/order id.
      if (tripId) {
        const trip = await prisma.trip.findUnique({ where: { id: tripId }, select: { riderId: true, driverId: true } });
        if (trip && trip.driverId === user.id) {
          io.to(`user:${trip.riderId}`).emit('trip:driver-location', { tripId, lat, lng, bearing });
        }
      }
      if (orderId) {
        const order = await prisma.deliveryOrder.findUnique({ where: { id: orderId }, select: { customerId: true, courierId: true } });
        if (order && order.courierId === user.id) {
          io.to(`user:${order.customerId}`).emit('order:courier-location', { orderId, lat, lng, bearing });
        }
      }
    });

    // ── Riders/customers watch the live ops zone (admin map) ──
    socket.on('presence:ping', async () => {
      const dp = await prisma.driverProfile.findUnique({ where: { userId: user.id } });
      if (dp?.isOnline) await prisma.driverProfile.update({ where: { id: dp.id }, data: { lastSeenAt: new Date() } });
    });

    // ── Chat (typing indicator only; messages go through REST + fan-out) ──
    socket.on('chat:typing', ({ conversationId, toUserId } = {}) => {
      if (toUserId) io.to(`user:${toUserId}`).emit('chat:typing', { conversationId, from: user.id });
    });

    socket.on('disconnect', async () => {
      const dp = await prisma.driverProfile.findUnique({ where: { userId: user.id } }).catch(() => null);
      if (dp?.isOnline) {
        await prisma.driverProfile.update({ where: { id: dp.id }, data: { isOnline: false } }).catch(() => {});
      }
      logger.info('[Socket] disconnected', { userId: user.id });
    });
  });

  return io;
}

module.exports = { initSocket };
