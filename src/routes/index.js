// Campus Connect API routes (v1).
const { Router } = require('express');
const { authenticate, requireRole } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');

// Brute-force protection on credential endpoints: 10 attempts / 15 min / IP.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

const auth = require('../controllers/authController');
const profile = require('../controllers/profileController');
const verification = require('../controllers/verificationController');
const trips = require('../controllers/tripController');
const drivers = require('../controllers/driverController');
const vendors = require('../controllers/vendorController');
const orders = require('../controllers/orderController');
const listings = require('../controllers/listingController');
const services = require('../controllers/serviceController');
const chat = require('../controllers/chatController');
const reviews = require('../controllers/reviewController');
const wallet = require('../controllers/walletController');
const coupons = require('../controllers/couponController');
const notifications = require('../controllers/notificationController');
const payments = require('../controllers/paymentController');
const universities = require('../controllers/universityController');
const admin = require('../controllers/adminController');
const uploads = require('../controllers/uploadController');

const router = Router();

// ── Uploads (authenticated, rate-limited image upload) ──
router.post('/uploads', authenticate, rateLimit({ windowMs: 60 * 1000, max: 30 }), uploads.single, uploads.create);

// ── Geo (server-side proxy so the TomTom key stays on the backend) ──
const geo = require('../controllers/geoController');
router.get('/geo/search', authenticate, rateLimit({ windowMs: 60 * 1000, max: 60 }), geo.search);
router.get('/geo/route', authenticate, rateLimit({ windowMs: 60 * 1000, max: 120 }), geo.route);

// ── Auth (public, rate-limited) ──
router.post('/auth/register', authLimiter, auth.register);
router.post('/auth/login', authLimiter, auth.login);
router.post('/auth/google', authLimiter, auth.google);
router.post('/auth/otp/request', authLimiter, auth.requestOtp);
router.post('/auth/otp/verify', authLimiter, auth.verifyOtp);
router.post('/auth/guest', auth.guest);
router.post('/auth/refresh', auth.refresh);
router.post('/auth/logout', auth.logout);
router.get('/auth/me', authenticate, auth.me);

// ── Profile & capability unlock ──
router.get('/profile', authenticate, profile.get);
router.put('/profile', authenticate, profile.update);
router.post('/profile/become-driver', authenticate, profile.becomeDriver);
router.post('/profile/become-vendor', authenticate, profile.becomeVendor);
router.post('/profile/become-provider', authenticate, profile.becomeProvider);

// ── Verification (KYC) ──
router.post('/verification', authenticate, verification.submit);
router.get('/verification', authenticate, verification.status);

// ── Rides ──
router.post('/trips/estimate', authenticate, trips.estimate);
router.post('/trips', authenticate, trips.create);
router.get('/trips', authenticate, trips.history);
router.get('/trips/:id', authenticate, trips.getOne);
router.post('/trips/:id/accept', authenticate, trips.accept);
router.post('/trips/:id/decline', authenticate, trips.decline);
router.patch('/trips/:id/status', authenticate, trips.updateStatus);
router.post('/trips/:id/cancel', authenticate, trips.cancel);

// ── Driver / Partner ──
router.get('/drivers/dashboard', authenticate, drivers.dashboard);
router.get('/drivers/jobs', authenticate, drivers.jobs);
router.put('/drivers/vehicle', authenticate, drivers.upsertVehicle);
router.get('/drivers/vehicle', authenticate, drivers.getVehicle);
router.post('/drivers/online', authenticate, drivers.setOnline);
router.post('/drivers/offline', authenticate, drivers.setOffline);
router.patch('/drivers/location', authenticate, drivers.updateLocation);

// ── Vendors & products ──
router.get('/vendors', vendors.list);
router.get('/vendors/:id', vendors.getOne);
router.put('/vendors/me', authenticate, vendors.updateMine);
router.get('/vendors/me/orders', authenticate, vendors.myOrders);
router.post('/vendors/me/products', authenticate, vendors.addProduct);
router.patch('/vendors/me/products/:productId', authenticate, vendors.updateProduct);

// ── Delivery orders ──
router.post('/orders', authenticate, orders.create);
router.get('/orders', authenticate, orders.history);
router.get('/orders/:id', authenticate, orders.getOne);
router.post('/orders/:id/accept', authenticate, orders.accept);
router.patch('/orders/:id/status', authenticate, orders.updateStatus);

// ── Universities (public) ──
router.get('/universities', universities.list);

// ── Categories (public) ──
router.get('/categories', listings.categories);

// ── Marketplace ──
router.get('/listings', listings.list);
router.get('/listings/mine', authenticate, listings.mine);
router.get('/listings/favorites', authenticate, listings.favorites);
router.get('/listings/:id', listings.getOne);
router.post('/listings', authenticate, listings.create);
router.patch('/listings/:id', authenticate, listings.update);
router.delete('/listings/:id', authenticate, listings.remove);
router.post('/listings/:id/favorite', authenticate, listings.toggleFavorite);
router.post('/listings/:id/report', authenticate, listings.report);

// ── Services ──
router.get('/services', services.list);
router.get('/services/bookings/mine', authenticate, services.myBookings);
router.patch('/services/bookings/:id', authenticate, services.updateBooking);
router.get('/services/:id', services.getOne);
router.post('/services', authenticate, services.create);
router.post('/services/:id/book', authenticate, services.book);

// ── Chat ──
router.post('/chat/start', authenticate, chat.start);
router.get('/chat', authenticate, chat.list);
router.get('/chat/:id/messages', authenticate, chat.messages);
router.post('/chat/:id/messages', authenticate, chat.send);

// ── Reviews ──
router.post('/reviews', authenticate, reviews.create);
router.get('/reviews', reviews.list);

// ── Wallet ──
router.get('/wallet', authenticate, wallet.get);
router.post('/wallet/topup', authenticate, wallet.topup);
router.post('/wallet/payout', authenticate, wallet.payout);

// ── Payments (Paystack) ──
router.post('/payments/webhook', payments.webhook); // public — Paystack server-to-server
router.post('/payments/initialize', authenticate, payments.initialize);
router.post('/payments/confirm', authenticate, payments.confirm);

// ── Coupons ──
router.post('/coupons/validate', authenticate, coupons.validate);
router.post('/coupons/redeem', authenticate, coupons.redeem);

// ── Notifications ──
router.get('/notifications', authenticate, notifications.list);
router.patch('/notifications/read-all', authenticate, notifications.markAllRead);
router.patch('/notifications/:id/read', authenticate, notifications.markRead);

// ── Admin ──
const { requirePermission } = require('../middleware/auth');
const adminOnly = [authenticate, requireRole('ADMIN', 'SUPER_ADMIN')];
const superOnly = [authenticate, requireRole('SUPER_ADMIN')];
const can = (perm) => [authenticate, requireRole('ADMIN', 'SUPER_ADMIN'), requirePermission(perm)];

// Dashboard + live ops: any admin.
router.get('/admin/dashboard', ...adminOnly, admin.dashboard);
router.get('/admin/live', ...adminOnly, admin.live);

// Per-area, permission-gated.
router.get('/admin/users', ...can('users'), admin.users);
router.patch('/admin/users/:id', ...can('users'), admin.setUserStatus);
router.get('/admin/verifications', ...can('verifications'), admin.verifications);
router.patch('/admin/verifications/:id', ...can('verifications'), admin.reviewVerification);
router.get('/admin/reports', ...can('reports'), admin.reports);
router.patch('/admin/reports/:id', ...can('reports'), admin.resolveReport);
router.patch('/admin/vendors/:id', ...can('vendors'), admin.setVendorStatus);
router.get('/admin/orders', ...can('orders'), admin.orders);
router.post('/admin/orders/:id/refund', ...can('orders'), admin.refundOrder);

// Admin management: super admin only.
router.get('/admin/admins', ...superOnly, admin.listAdmins);
router.post('/admin/admins', ...superOnly, admin.addAdmin);
router.patch('/admin/admins/:id', ...superOnly, admin.updateAdmin);
router.delete('/admin/admins/:id', ...superOnly, admin.removeAdmin);

module.exports = router;
