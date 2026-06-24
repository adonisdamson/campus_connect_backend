// Delivery orders — food / parcel / shopping / gas.
const prisma = require('../config/database');
const { asyncHandler, fail, ok } = require('../utils/http');
const { estimateDelivery } = require('../services/pricing');
const { dispatchOrder } = require('../services/dispatch');
const { credit, debit, getOrCreate } = require('../services/wallet');
const { notify } = require('../services/notify');

const TYPES = ['FOOD', 'PARCEL', 'SHOPPING', 'GAS'];
const PAYMENT_METHODS = ['WALLET', 'CASH', 'MTN_MOMO', 'TELECEL_CASH', 'AIRTELTIGO', 'CARD'];

// POST /orders  { type, vendorId?, items?[{productId,quantity}], parcelDescription?, pickup{address,lat,lng}, dropoff{address,lat,lng}, paymentMethod, notes? }
exports.create = asyncHandler(async (req, res) => {
  const b = req.body;
  if (!TYPES.includes(b.type)) fail(400, 'Invalid delivery type');
  if (!PAYMENT_METHODS.includes(b.paymentMethod)) fail(400, 'Invalid payment method');
  if (!b.dropoff?.lat || !b.dropoff?.lng || !b.dropoff?.address) fail(400, 'dropoff address+coords required');

  let pickup = b.pickup;
  let vendorId = null;
  let items = [];
  let subtotal = 0;

  if (b.type === 'FOOD') {
    if (!b.vendorId) fail(400, 'vendorId required for food orders');
    const vendor = await prisma.vendor.findUnique({ where: { id: b.vendorId } });
    if (!vendor) fail(404, 'Vendor not found');
    vendorId = vendor.id;
    pickup = { address: vendor.address, lat: vendor.lat, lng: vendor.lng };
    const productIds = (b.items || []).map((i) => i.productId);
    const products = await prisma.product.findMany({ where: { id: { in: productIds }, vendorId } });
    items = (b.items || []).map((i) => {
      const p = products.find((x) => x.id === i.productId);
      if (!p) fail(400, `Invalid product ${i.productId}`);
      const qty = Math.max(1, +i.quantity || 1);
      // Resolve any chosen modifiers against the product's own option groups so a
      // client can't invent options or tamper with their prices — we use the
      // SERVER price for every matched choice.
      const groups = Array.isArray(p.options) ? p.options : [];
      const chosen = Array.isArray(i.options) ? i.options : [];
      const resolved = [];
      let modTotal = 0;
      for (const c of chosen) {
        for (const g of groups) {
          const match = (g.choices || []).find((ch) => ch.label === c.label && (c.group == null || c.group === g.name));
          if (match) {
            const price = Number(match.price) || 0;
            modTotal += price;
            resolved.push({ group: g.name, label: match.label, price });
            break;
          }
        }
      }
      const lineTotal = (Number(p.price) + modTotal) * qty;
      subtotal += lineTotal;
      return { productId: p.id, name: p.name, quantity: qty, unitPrice: p.price, lineTotal, notes: i.notes, options: resolved.length ? resolved : undefined };
    });
    if (items.length === 0) fail(400, 'At least one item required');
  } else {
    if (!pickup?.lat || !pickup?.lng || !pickup?.address) fail(400, 'pickup address+coords required');
  }

  const fees = estimateDelivery(b.type, pickup, b.dropoff);
  const total = subtotal + fees.deliveryFee + fees.serviceFee;

  if (b.paymentMethod === 'WALLET') {
    const wallet = await getOrCreate(req.user.id);
    if (Number(wallet.balance) < total) fail(402, 'Top up your wallet to place this order');
  }

  const order = await prisma.deliveryOrder.create({
    data: {
      customerId: req.user.id, vendorId, type: b.type,
      status: b.type === 'FOOD' ? 'PENDING' : 'CONFIRMED',
      parcelDescription: b.parcelDescription, notes: b.notes,
      pickupAddress: pickup.address, pickupLat: +pickup.lat, pickupLng: +pickup.lng,
      dropoffAddress: b.dropoff.address, dropoffLat: +b.dropoff.lat, dropoffLng: +b.dropoff.lng,
      subtotal, deliveryFee: fees.deliveryFee, serviceFee: fees.serviceFee, total,
      paymentMethod: b.paymentMethod,
      items: { create: items },
    },
    include: { items: true },
  });

  // Non-food orders go straight to courier dispatch; food waits for vendor to mark READY.
  if (b.type !== 'FOOD') await dispatchOrder(req.app.get('io'), order);
  return ok(res, { order }, 201);
});

// PATCH /orders/:id/status  { status }  — vendor or courier advances
exports.updateStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  const valid = ['CONFIRMED', 'PREPARING', 'READY', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED'];
  if (!valid.includes(status)) fail(400, 'Invalid status');
  const order = await prisma.deliveryOrder.findUnique({ where: { id: req.params.id } });
  if (!order) fail(404, 'Order not found');

  // ── Authorization: who may move this order to which state ──
  const u = req.user;
  const isAdmin = u.role === 'ADMIN' || u.role === 'SUPER_ADMIN';
  const isCustomer = order.customerId === u.id;
  const isCourier = order.courierId === u.id;
  let isVendorOwner = false;
  if (order.vendorId) {
    const v = await prisma.vendor.findUnique({ where: { id: order.vendorId }, select: { ownerId: true } });
    isVendorOwner = v?.ownerId === u.id;
  }
  const VENDOR_STATUSES = ['CONFIRMED', 'PREPARING', 'READY'];
  const COURIER_STATUSES = ['PICKED_UP', 'IN_TRANSIT', 'DELIVERED'];
  const allowed = isAdmin
    ? true
    : status === 'CANCELLED'
      // Customer may cancel only before pickup; vendor/courier may cancel their leg.
      ? (isCustomer && ['PENDING', 'CONFIRMED', 'PREPARING'].includes(order.status)) || isVendorOwner || isCourier
      : isVendorOwner
        ? VENDOR_STATUSES.includes(status)
        : isCourier
          ? COURIER_STATUSES.includes(status)
          : false;
  if (!allowed) fail(403, 'Not authorized to update this order');

  const stamp = { CONFIRMED: 'confirmedAt', READY: 'readyAt', PICKED_UP: 'pickedUpAt', DELIVERED: 'deliveredAt', CANCELLED: 'cancelledAt' }[status];
  const updated = await prisma.deliveryOrder.update({
    where: { id: order.id }, data: { status, ...(stamp ? { [stamp]: new Date() } : {}) },
  });

  const io = req.app.get('io');

  // When food is READY, dispatch a courier.
  if (status === 'READY' && !order.courierId) await dispatchOrder(io, updated);

  if (status === 'DELIVERED') {
    // Wallet customers pay now; cash settles in person. Courier + vendor get paid.
    if (order.paymentMethod === 'WALLET') {
      await debit(order.customerId, Number(order.total), 'ORDER_PAYMENT', { contextType: 'ORDER', contextId: order.id }).catch(() => {});
    }
    if (order.courierId) {
      await credit(order.courierId, Number(order.deliveryFee), 'ORDER_PAYMENT', { contextType: 'ORDER', contextId: order.id });
    }
    if (order.vendorId && Number(order.subtotal) > 0) {
      const vendor = await prisma.vendor.findUnique({ where: { id: order.vendorId }, select: { ownerId: true } });
      if (vendor) await credit(vendor.ownerId, Number(order.subtotal), 'ORDER_PAYMENT', { contextType: 'ORDER', contextId: order.id });
    }
    await prisma.deliveryOrder.update({ where: { id: order.id }, data: { paymentStatus: 'PAID' } });
  }

  io.to(`user:${order.customerId}`).emit('order:status-changed', { orderId: order.id, status });

  const note = {
    CONFIRMED: { title: 'Order confirmed', body: 'Your order is being prepared', type: 'DELIVERY' },
    READY: { title: 'Order ready', body: 'Finding a courier for your order', type: 'DELIVERY' },
    PICKED_UP: { title: 'On the way', body: 'Your order has been picked up', type: 'DELIVERY' },
    DELIVERED: { title: 'Delivered', body: 'Your order has arrived. Enjoy!', type: 'DELIVERY' },
  }[status];
  if (note) await notify(io, order.customerId, { ...note, data: { orderId: order.id } });

  return ok(res, { order: updated });
});

// POST /orders/:id/accept  (courier)
exports.accept = asyncHandler(async (req, res) => {
  const dp = await prisma.driverProfile.findUnique({ where: { userId: req.user.id } });
  if (!dp) fail(403, 'Not a courier');
  const order = await prisma.$transaction(async (tx) => {
    const o = await tx.deliveryOrder.findUnique({ where: { id: req.params.id } });
    if (!o) return { error: 'Order not found', status: 404 };
    if (o.courierId) return { error: 'Order already assigned', status: 409 };
    return tx.deliveryOrder.update({ where: { id: o.id }, data: { courierId: req.user.id, status: 'COURIER_ASSIGNED' } });
  });
  if (order.error) fail(order.status, order.error);
  const io = req.app.get('io');
  io.to(`user:${order.customerId}`).emit('order:status-changed', { orderId: order.id, status: 'COURIER_ASSIGNED' });
  await notify(io, order.customerId, { title: 'Courier assigned', body: `${req.user.fullName || 'A courier'} is handling your delivery`, type: 'DELIVERY', data: { orderId: order.id } });
  return ok(res, { order });
});

// GET /orders/:id
exports.getOne = asyncHandler(async (req, res) => {
  const order = await prisma.deliveryOrder.findUnique({
    where: { id: req.params.id },
    include: { items: true, vendor: { select: { name: true, logoUrl: true, ownerId: true } }, courier: { select: { fullName: true, profilePhoto: true } } },
  });
  if (!order) fail(404, 'Order not found');

  // Ownership: customer, assigned courier, the vendor owner, or an admin only.
  const u = req.user;
  const isAdmin = u.role === 'ADMIN' || u.role === 'SUPER_ADMIN';
  const allowed = isAdmin || order.customerId === u.id || order.courierId === u.id || order.vendor?.ownerId === u.id;
  if (!allowed) fail(403, 'Not authorized to view this order');

  // Don't leak the vendor ownerId to clients.
  if (order.vendor) delete order.vendor.ownerId;
  return ok(res, { order });
});

// GET /orders — customer history
exports.history = asyncHandler(async (req, res) => {
  const orders = await prisma.deliveryOrder.findMany({
    where: { customerId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 50,
    include: { vendor: { select: { name: true, logoUrl: true } }, items: true },
  });
  return ok(res, { orders });
});
