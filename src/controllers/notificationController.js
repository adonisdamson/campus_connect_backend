// In-app notifications.
const prisma = require('../config/database');
const { asyncHandler, ok } = require('../utils/http');

// GET /notifications
exports.list = asyncHandler(async (req, res) => {
  const notifications = await prisma.notification.findMany({
    where: { userId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 100,
  });
  const unread = await prisma.notification.count({ where: { userId: req.user.id, isRead: false } });
  return ok(res, { notifications, unread });
});

// PATCH /notifications/:id/read
exports.markRead = asyncHandler(async (req, res) => {
  await prisma.notification.updateMany({ where: { id: req.params.id, userId: req.user.id }, data: { isRead: true } });
  return ok(res, { read: true });
});

// PATCH /notifications/read-all
exports.markAllRead = asyncHandler(async (req, res) => {
  await prisma.notification.updateMany({ where: { userId: req.user.id, isRead: false }, data: { isRead: true } });
  return ok(res, { read: true });
});
