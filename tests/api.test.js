// Integration tests — exercise the real app against the local dev database.
const request = require('supertest');
const { app } = require('../src/index');
const prisma = require('../src/config/database');

const rand = () => Math.random().toString(36).slice(2, 10);
const api = () => request(app);

async function newUser(extra = {}) {
  const email = `t_${rand()}@example.com`;
  const res = await api().post('/api/v1/auth/register').send({ email, password: 'secret123', fullName: 'Test User', ...extra });
  return { token: res.body.accessToken, refresh: res.body.refreshToken, user: res.body.user, email };
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

// Promote a freshly-registered user to ADMIN. Safe to call before any
// authenticated request (the auth cache hasn't seen them yet), so the next
// call reads role=ADMIN from the DB.
async function adminUser() {
  const u = await newUser();
  await prisma.user.update({ where: { id: u.user.id }, data: { role: 'ADMIN' } });
  return u;
}

// Take a driver through the real verification → admin-approval chain so they're
// allowed to go online. Returns once the driver profile is ACTIVE.
async function approveDriver(driver) {
  await api().post('/api/v1/profile/become-driver').set(auth(driver.token)).send({ doesRides: true });
  await api().put('/api/v1/drivers/vehicle').set(auth(driver.token)).send({ type: 'CAR', plate: `GT-${rand()}` });
  const sub = await api().post('/api/v1/verification').set(auth(driver.token))
    .send({ type: 'DRIVER', idDocType: 'GHANA_CARD', idFrontUrl: 'http://localhost/uploads/id.jpg', selfieUrl: 'http://localhost/uploads/selfie.jpg' });
  const admin = await adminUser();
  await api().patch(`/api/v1/admin/verifications/${sub.body.verification.id}`).set(auth(admin.token)).send({ decision: 'APPROVED' });
}

describe('Auth', () => {
  test('register → login → me → refresh', async () => {
    const { token, refresh, email } = await newUser();
    expect(token).toBeTruthy();

    const login = await api().post('/api/v1/auth/login').send({ email, password: 'secret123' });
    expect(login.status).toBe(200);
    expect(login.body.user.email).toBe(email);

    const me = await api().get('/api/v1/auth/me').set(auth(token));
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email);

    const ref = await api().post('/api/v1/auth/refresh').send({ refreshToken: refresh });
    expect(ref.status).toBe(200);
    expect(ref.body.accessToken).toBeTruthy();
  });

  test('rejects bad credentials and missing token', async () => {
    const bad = await api().post('/api/v1/auth/login').send({ email: 'no@one.com', password: 'x' });
    expect(bad.status).toBe(401);
    const noTok = await api().get('/api/v1/auth/me');
    expect(noTok.status).toBe(401);
  });
});

describe('Rides — estimate, dispatch, accept, complete', () => {
  test('estimate returns all four classes', async () => {
    const { token } = await newUser();
    const res = await api().post('/api/v1/trips/estimate').set(auth(token))
      .send({ pickupLat: 5.301, pickupLng: -1.996, dropoffLat: 5.315, dropoffLng: -2.001 });
    expect(res.status).toBe(200);
    expect(res.body.estimates).toHaveLength(4);
    expect(res.body.estimates.every((e) => e.fareEstimate > 0)).toBe(true);
  });

  test('online driver gets dispatched and can accept + complete', async () => {
    const rider = await newUser();
    const driver = await newUser();
    await approveDriver(driver);
    const online = await api().post('/api/v1/drivers/online').set(auth(driver.token)).send({ lat: 5.301, lng: -1.996 });
    expect(online.body.isOnline).toBe(true);

    const create = await api().post('/api/v1/trips').set(auth(rider.token)).send({
      rideClass: 'ECONOMY', pickupAddress: 'Gate', pickupLat: 5.301, pickupLng: -1.996,
      dropoffAddress: 'Market', dropoffLat: 5.315, dropoffLng: -2.001, paymentMethod: 'CASH',
    });
    expect(create.status).toBe(201);
    const tripId = create.body.trip.id;

    // dispatch ran synchronously inside create → trip should be offered
    const got = await api().get(`/api/v1/trips/${tripId}`).set(auth(rider.token));
    expect(got.body.trip.status).toBe('DRIVER_ASSIGNED');

    const accept = await api().post(`/api/v1/trips/${tripId}/accept`).set(auth(driver.token));
    expect(accept.body.trip.status).toBe('ACCEPTED');

    const done = await api().patch(`/api/v1/trips/${tripId}/status`).set(auth(driver.token)).send({ status: 'COMPLETED' });
    expect(done.body.trip.status).toBe('COMPLETED');

    const dash = await api().get('/api/v1/drivers/dashboard').set(auth(driver.token));
    expect(dash.body.earnings.today).toBeGreaterThan(0);
  });
});

describe('Food modifiers', () => {
  test('order applies server-validated modifier prices and ignores client tampering', async () => {
    const owner = await newUser();
    const v = await api().post('/api/v1/profile/become-vendor').set(auth(owner.token))
      .send({ name: 'Test Kitchen', category: 'RESTAURANT', address: 'Campus', lat: 5.301, lng: -1.996 });
    const vendorId = v.body.vendor.id;
    const prod = await api().post('/api/v1/vendors/me/products').set(auth(owner.token))
      .send({ name: 'Jollof', price: 20, options: [{ name: 'Size', choices: [{ label: 'Large', price: 5 }] }] });
    const productId = prod.body.product.id;

    const customer = await newUser();
    const order = await api().post('/api/v1/orders').set(auth(customer.token)).send({
      type: 'FOOD', vendorId, paymentMethod: 'CASH',
      items: [{ productId, quantity: 2, options: [{ group: 'Size', label: 'Large', price: 9999 }] }],
      dropoff: { address: 'Hall', lat: 5.31, lng: -2.0 },
    });
    expect(order.status).toBe(201);
    // (20 base + 5 modifier) * 2 = 50; the spoofed 9999 is ignored.
    expect(Number(order.body.order.subtotal)).toBe(50);
    expect(Number(order.body.order.items[0].lineTotal)).toBe(50);
  });
});

describe('Refunds', () => {
  test('admin refunds a wallet order back to the customer, once', async () => {
    const customer = await newUser();
    await api().post('/api/v1/wallet/topup').set(auth(customer.token)).send({ amount: 100 });
    const order = await api().post('/api/v1/orders').set(auth(customer.token)).send({
      type: 'PARCEL', parcelDescription: 'docs',
      pickup: { address: 'A', lat: 5.301, lng: -1.996 },
      dropoff: { address: 'B', lat: 5.31, lng: -2.0 }, paymentMethod: 'WALLET',
    });
    const id = order.body.order.id;
    const before = await api().get('/api/v1/wallet').set(auth(customer.token));

    const admin = await adminUser();
    const refund = await api().post(`/api/v1/admin/orders/${id}/refund`).set(auth(admin.token)).send({ amount: 10, reason: 'late' });
    expect(refund.status).toBe(200);

    const after = await api().get('/api/v1/wallet').set(auth(customer.token));
    expect(after.body.balance).toBe(before.body.balance + 10);

    const again = await api().post(`/api/v1/admin/orders/${id}/refund`).set(auth(admin.token)).send({ amount: 10 });
    expect(again.status).toBe(409);
  });

  test('non-admin cannot refund', async () => {
    const u = await newUser();
    const res = await api().post('/api/v1/admin/orders/whatever/refund').set(auth(u.token)).send({ amount: 5 });
    expect(res.status).toBe(403);
  });
});

describe('Delivery — parcel order', () => {
  test('creates a parcel order with computed fees', async () => {
    const { token } = await newUser();
    const res = await api().post('/api/v1/orders').set(auth(token)).send({
      type: 'PARCEL', parcelDescription: 'Documents',
      pickup: { address: 'Hall A', lat: 5.301, lng: -1.996 },
      dropoff: { address: 'Hall B', lat: 5.310, lng: -2.0 },
      paymentMethod: 'CASH',
    });
    expect(res.status).toBe(201);
    expect(res.body.order.type).toBe('PARCEL');
    expect(Number(res.body.order.deliveryFee)).toBeGreaterThan(0);
    expect(res.body.order.status).toBe('CONFIRMED');
  });
});

describe('Marketplace', () => {
  test('create → appears in list → favorite toggles', async () => {
    const { token } = await newUser();
    const cats = await api().get('/api/v1/categories').query({ type: 'MARKETPLACE' });
    expect(cats.status).toBe(200);
    expect(cats.body.categories.length).toBeGreaterThan(0);
    const categoryId = cats.body.categories[0].id;

    const created = await api().post('/api/v1/listings').set(auth(token)).send({
      title: `iPhone ${rand()}`, description: 'Clean, boxed', price: 2500, categoryId, condition: 'USED',
    });
    expect(created.status).toBe(201);
    const id = created.body.listing.id;

    const list = await api().get('/api/v1/listings');
    expect(list.body.listings.some((l) => l.id === id)).toBe(true);

    const fav = await api().post(`/api/v1/listings/${id}/favorite`).set(auth(token));
    expect(fav.body.favorited).toBe(true);
    const unfav = await api().post(`/api/v1/listings/${id}/favorite`).set(auth(token));
    expect(unfav.body.favorited).toBe(false);
  });

  test('listing search is paginated', async () => {
    const res = await api().get('/api/v1/listings').query({ page: 1, limit: 5 });
    expect(res.status).toBe(200);
    expect(res.body.listings.length).toBeLessThanOrEqual(5);
    expect(typeof res.body.total).toBe('number');
    expect(res.body).toHaveProperty('hasMore');
  });
});

describe('Wallet + coupons', () => {
  test('dev top-up credits balance', async () => {
    const { token } = await newUser();
    const top = await api().post('/api/v1/wallet/topup').set(auth(token)).send({ amount: 40 });
    expect(top.status).toBe(200);
    expect(top.body.balance).toBe(40);
  });

  test('WELCOME10 coupon validates to a discount', async () => {
    const { token } = await newUser();
    const res = await api().post('/api/v1/coupons/validate').set(auth(token)).send({ code: 'WELCOME10', amount: 50, context: 'RIDE' });
    expect(res.status).toBe(200);
    expect(res.body.discount).toBe(5);
  });
});

describe('Uploads', () => {
  test('accepts an image and rejects a non-image', async () => {
    const { token } = await newUser();
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'); // PNG magic header
    const okRes = await api().post('/api/v1/uploads').set(auth(token))
      .attach('file', png, { filename: 'doc.png', contentType: 'image/png' });
    expect(okRes.status).toBe(201);
    expect(okRes.body.url).toMatch(/\/uploads\//);

    const bad = await api().post('/api/v1/uploads').set(auth(token))
      .attach('file', Buffer.from('not an image'), { filename: 'x.txt', contentType: 'text/plain' });
    expect(bad.status).toBe(400);
  });

  test('upload requires authentication', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const res = await api().post('/api/v1/uploads').attach('file', png, { filename: 'a.png', contentType: 'image/png' });
    expect(res.status).toBe(401);
  });
});

describe('Admin gating', () => {
  test('non-admin is forbidden from the dashboard', async () => {
    const { token } = await newUser();
    const res = await api().get('/api/v1/admin/dashboard').set(auth(token));
    expect(res.status).toBe(403);
  });
});

describe('Security — authorization boundaries', () => {
  test('unapproved driver cannot go online', async () => {
    const driver = await newUser();
    await api().post('/api/v1/profile/become-driver').set(auth(driver.token)).send({ doesRides: true });
    await api().put('/api/v1/drivers/vehicle').set(auth(driver.token)).send({ type: 'CAR', plate: `GT-${rand()}` });
    const online = await api().post('/api/v1/drivers/online').set(auth(driver.token)).send({ lat: 5.301, lng: -1.996 });
    expect(online.status).toBe(403);
  });

  test('a stranger cannot read or mutate someone else\'s order', async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const created = await api().post('/api/v1/orders').set(auth(owner.token)).send({
      type: 'PARCEL', parcelDescription: 'Secret docs',
      pickup: { address: 'Hall A', lat: 5.301, lng: -1.996 },
      dropoff: { address: 'Hall B', lat: 5.310, lng: -2.0 }, paymentMethod: 'CASH',
    });
    const orderId = created.body.order.id;

    const read = await api().get(`/api/v1/orders/${orderId}`).set(auth(stranger.token));
    expect(read.status).toBe(403);

    const mutate = await api().patch(`/api/v1/orders/${orderId}/status`).set(auth(stranger.token)).send({ status: 'DELIVERED' });
    expect(mutate.status).toBe(403);

    // owner can still read their own order
    const ownRead = await api().get(`/api/v1/orders/${orderId}`).set(auth(owner.token));
    expect(ownRead.status).toBe(200);
  });

  test('verification rejects non-uploaded (local://) document refs', async () => {
    const driver = await newUser();
    const res = await api().post('/api/v1/verification').set(auth(driver.token))
      .send({ type: 'DRIVER', idDocType: 'GHANA_CARD', idFrontUrl: 'local://id', selfieUrl: 'local://selfie' });
    expect(res.status).toBe(400);
  });

  test('cannot start a ride chat for a trip you are not part of', async () => {
    const rider = await newUser();
    const outsider = await newUser();
    const create = await api().post('/api/v1/trips').set(auth(rider.token)).send({
      rideClass: 'ECONOMY', pickupAddress: 'Gate', pickupLat: 5.301, pickupLng: -1.996,
      dropoffAddress: 'Market', dropoffLat: 5.315, dropoffLng: -2.001, paymentMethod: 'CASH',
    });
    const tripId = create.body.trip.id;
    const res = await api().post('/api/v1/chat/start').set(auth(outsider.token)).send({ type: 'RIDE', contextId: tripId });
    expect(res.status).toBe(403);
  });
});

afterAll(async () => {
  const prisma = require('../src/config/database');
  await prisma.$disconnect();
});
