// Create a stored notification AND push it live over the socket.
const prisma = require('../config/database');

async function notify(io, userId, { title, body, type = 'SYSTEM', data } = {}) {
  if (!userId || !title) return null;
  try {
    const n = await prisma.notification.create({ data: { userId, title, body, type, data } });
    io?.to(`user:${userId}`).emit('notification:new', { id: n.id, title, body, type, data });
    return n;
  } catch (_) {
    return null;
  }
}

module.exports = { notify };
