// Chat — conversations & messages across rides/orders/marketplace/services.
const prisma = require('../config/database');
const { asyncHandler, fail, ok } = require('../utils/http');

// Get or create a conversation between the current user and another, for a context.
async function getOrCreate(meId, otherId, type, contextId) {
  if (contextId) {
    const found = await prisma.conversation.findFirst({
      where: { type, contextId, participants: { some: { userId: meId } } },
      include: { participants: true },
    });
    if (found) return found;
  }
  return prisma.conversation.create({
    data: {
      type, contextId,
      participants: { create: [{ userId: meId }, ...(otherId && otherId !== meId ? [{ userId: otherId }] : [])] },
    },
    include: { participants: true },
  });
}

// POST /chat/start  { otherUserId, type, contextId? }
// Guarded: a user may only open a conversation about a context they belong to,
// and the recipient is derived/validated from that context — you can't DM an
// arbitrary user by guessing ids.
exports.start = asyncHandler(async (req, res) => {
  const { otherUserId, type, contextId } = req.body;
  const validTypes = ['RIDE', 'ORDER', 'MARKETPLACE', 'SERVICE', 'DIRECT'];
  if (!validTypes.includes(type)) fail(400, 'Invalid conversation type');

  const me = req.user.id;
  let recipient = otherUserId;

  if (type === 'RIDE') {
    if (!contextId) fail(400, 'contextId required for ride chats');
    const trip = await prisma.trip.findUnique({ where: { id: contextId }, select: { riderId: true, driverId: true } });
    if (!trip || (trip.riderId !== me && trip.driverId !== me)) fail(403, 'Not part of this trip');
    recipient = trip.riderId === me ? trip.driverId : trip.riderId;
  } else if (type === 'ORDER') {
    if (!contextId) fail(400, 'contextId required for order chats');
    const order = await prisma.deliveryOrder.findUnique({ where: { id: contextId }, select: { customerId: true, courierId: true, vendorId: true } });
    let vendorOwnerId = null;
    if (order?.vendorId) {
      const v = await prisma.vendor.findUnique({ where: { id: order.vendorId }, select: { ownerId: true } });
      vendorOwnerId = v?.ownerId || null;
    }
    const parties = [order?.customerId, order?.courierId, vendorOwnerId].filter(Boolean);
    if (!order || !parties.includes(me)) fail(403, 'Not part of this order');
    if (recipient && !parties.includes(recipient)) fail(403, 'Recipient is not part of this order');
  } else if (type === 'MARKETPLACE') {
    if (!contextId) fail(400, 'contextId required for marketplace chats');
    const listing = await prisma.listing.findUnique({ where: { id: contextId }, select: { sellerId: true } });
    if (!listing) fail(404, 'Listing not found');
    if (me !== listing.sellerId) recipient = listing.sellerId; // buyer → seller
    else if (!recipient) fail(400, 'otherUserId required');     // seller → buyer
  } else if (type === 'SERVICE') {
    if (!contextId) fail(400, 'contextId required for service chats');
    const svc = await prisma.serviceListing.findUnique({ where: { id: contextId }, select: { provider: { select: { userId: true } } } });
    if (!svc) fail(404, 'Service not found');
    const providerUserId = svc.provider.userId;
    if (me !== providerUserId) recipient = providerUserId;      // customer → provider
    else if (!recipient) fail(400, 'otherUserId required');     // provider → customer
  } else {
    // DIRECT
    if (!recipient) fail(400, 'otherUserId required');
  }

  if (recipient) {
    if (recipient === me) fail(400, 'Cannot start a conversation with yourself');
    const exists = await prisma.user.findUnique({ where: { id: recipient }, select: { id: true } });
    if (!exists) fail(404, 'Recipient not found');
  }

  const convo = await getOrCreate(me, recipient, type, contextId);
  return ok(res, { conversation: convo });
});

// GET /chat — my conversations
exports.list = asyncHandler(async (req, res) => {
  const convos = await prisma.conversation.findMany({
    where: { participants: { some: { userId: req.user.id } } },
    orderBy: { createdAt: 'desc' },
    include: {
      participants: { include: { user: { select: { id: true, fullName: true, profilePhoto: true } } } },
      messages: { orderBy: { sentAt: 'desc' }, take: 1 },
    },
  });
  return ok(res, { conversations: convos });
});

// GET /chat/:id/messages
exports.messages = asyncHandler(async (req, res) => {
  const part = await prisma.conversationParticipant.findFirst({ where: { conversationId: req.params.id, userId: req.user.id } });
  if (!part) fail(403, 'Not a participant');
  const messages = await prisma.message.findMany({ where: { conversationId: req.params.id }, orderBy: { sentAt: 'asc' }, take: 200 });
  await prisma.conversationParticipant.update({ where: { id: part.id }, data: { lastReadAt: new Date() } });
  return ok(res, { messages });
});

// POST /chat/:id/messages  { body, attachmentUrl?, type? }
exports.send = asyncHandler(async (req, res) => {
  const part = await prisma.conversationParticipant.findFirst({ where: { conversationId: req.params.id, userId: req.user.id } });
  if (!part) fail(403, 'Not a participant');
  if (!req.body.body && !req.body.attachmentUrl) fail(400, 'Message body or attachment required');
  const message = await prisma.message.create({
    data: {
      conversationId: req.params.id, senderId: req.user.id,
      body: req.body.body, attachmentUrl: req.body.attachmentUrl, type: req.body.type || 'TEXT',
    },
  });
  // Fan out to other participants.
  const others = await prisma.conversationParticipant.findMany({ where: { conversationId: req.params.id, userId: { not: req.user.id } } });
  const io = req.app.get('io');
  for (const o of others) io.to(`user:${o.userId}`).emit('chat:new-message', { conversationId: req.params.id, message });
  return ok(res, { message }, 201);
});

module.exports.getOrCreate = getOrCreate;
