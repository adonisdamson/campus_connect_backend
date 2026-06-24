// Services marketplace — provider listings + bookings.
const prisma = require('../config/database');
const { asyncHandler, fail, ok } = require('../utils/http');
const { notify } = require('../services/notify');

const PRICE_TYPES = ['FIXED', 'HOURLY', 'STARTING_AT'];

// GET /services?q&categoryId
exports.list = asyncHandler(async (req, res) => {
  const { q, categoryId } = req.query;
  const services = await prisma.serviceListing.findMany({
    where: {
      status: 'ACTIVE',
      ...(categoryId ? { categoryId } : {}),
      ...(q ? { OR: [{ title: { contains: q, mode: 'insensitive' } }, { description: { contains: q, mode: 'insensitive' } }] } : {}),
    },
    orderBy: { ratingAvg: 'desc' }, take: 60,
    include: { category: true, provider: { include: { user: { select: { fullName: true, profilePhoto: true } } } } },
  });
  return ok(res, { services });
});

// GET /services/:id
exports.getOne = asyncHandler(async (req, res) => {
  const service = await prisma.serviceListing.findUnique({
    where: { id: req.params.id },
    include: { category: true, provider: { include: { user: { select: { id: true, fullName: true, profilePhoto: true, phone: true } } } } },
  });
  if (!service) fail(404, 'Service not found');
  const reviews = await prisma.review.findMany({ where: { subjectType: 'SERVICE', subjectId: service.id }, take: 20, orderBy: { createdAt: 'desc' } });
  return ok(res, { service, reviews });
});

// POST /services  (provider)  { title, description, basePrice, priceType?, categoryId, coverUrl?, gallery?, availability?, lat?, lng? }
exports.create = asyncHandler(async (req, res) => {
  const provider = await prisma.serviceProviderProfile.findUnique({ where: { userId: req.user.id } });
  if (!provider) fail(403, 'Create a service-provider profile first');
  const b = req.body;
  if (!b.title || !b.description || b.basePrice == null || !b.categoryId) fail(400, 'title, description, basePrice, categoryId required');
  const service = await prisma.serviceListing.create({
    data: {
      providerId: provider.id, title: b.title, description: b.description, basePrice: +b.basePrice,
      priceType: PRICE_TYPES.includes(b.priceType) ? b.priceType : 'STARTING_AT',
      categoryId: b.categoryId, coverUrl: b.coverUrl, gallery: b.gallery, availability: b.availability,
      lat: b.lat != null ? +b.lat : null, lng: b.lng != null ? +b.lng : null,
    },
  });
  return ok(res, { service }, 201);
});

// POST /services/:id/book  { scheduledAt?, notes? }
exports.book = asyncHandler(async (req, res) => {
  const service = await prisma.serviceListing.findUnique({ where: { id: req.params.id }, include: { provider: true } });
  if (!service) fail(404, 'Service not found');
  const booking = await prisma.serviceBooking.create({
    data: {
      serviceId: service.id, customerId: req.user.id,
      scheduledAt: req.body.scheduledAt ? new Date(req.body.scheduledAt) : null,
      notes: req.body.notes, agreedPrice: service.basePrice,
    },
  });
  await notify(req.app.get('io'), service.provider.userId, {
    title: 'New service request', body: service.title, type: 'SERVICE', data: { bookingId: booking.id },
  });
  return ok(res, { booking }, 201);
});

// PATCH /services/bookings/:id  { status }  (provider or customer)
exports.updateBooking = asyncHandler(async (req, res) => {
  const { status } = req.body;
  const valid = ['ACCEPTED', 'DECLINED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
  if (!valid.includes(status)) fail(400, 'Invalid status');
  const booking = await prisma.serviceBooking.findUnique({ where: { id: req.params.id }, include: { service: { include: { provider: true } } } });
  if (!booking) fail(404, 'Booking not found');
  const isProvider = booking.service.provider.userId === req.user.id;
  const isCustomer = booking.customerId === req.user.id;
  if (!isProvider && !isCustomer) fail(403, 'Forbidden');
  const updated = await prisma.serviceBooking.update({ where: { id: booking.id }, data: { status } });
  const otherParty = isProvider ? booking.customerId : booking.service.provider.userId;
  await notify(req.app.get('io'), otherParty, {
    title: 'Service update', body: `${booking.service.title}: ${status.toLowerCase()}`, type: 'SERVICE', data: { bookingId: booking.id },
  });
  return ok(res, { booking: updated });
});

// GET /services/bookings/mine?role=customer|provider
exports.myBookings = asyncHandler(async (req, res) => {
  if (req.query.role === 'provider') {
    const provider = await prisma.serviceProviderProfile.findUnique({ where: { userId: req.user.id } });
    if (!provider) return ok(res, { bookings: [] });
    const bookings = await prisma.serviceBooking.findMany({
      where: { service: { providerId: provider.id } }, orderBy: { createdAt: 'desc' },
      include: { service: true, customer: { select: { fullName: true, profilePhoto: true } } },
    });
    return ok(res, { bookings });
  }
  const bookings = await prisma.serviceBooking.findMany({
    where: { customerId: req.user.id }, orderBy: { createdAt: 'desc' }, include: { service: true },
  });
  return ok(res, { bookings });
});
