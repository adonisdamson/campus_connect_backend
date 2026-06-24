// Payments — initialize a Paystack charge and confirm it (webhook or poll).
const crypto = require('crypto');
const prisma = require('../config/database');
const logger = require('../config/logger');
const { asyncHandler, fail, ok } = require('../utils/http');
const { isProd } = require('../config/env');
const payment = require('../services/payment');
const { credit } = require('../services/wallet');

// POST /payments/initialize  { amount, purpose? }
exports.initialize = asyncHandler(async (req, res) => {
  const amount = parseFloat(req.body.amount);
  if (!(amount > 0)) fail(400, 'amount must be positive');
  const purpose = req.body.purpose || 'TOPUP';
  const reference = `CC_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  await prisma.paymentTransaction.create({
    data: { userId: req.user.id, method: 'MTN_MOMO', amount, reference, purpose, status: 'PENDING' },
  });

  const init = await payment.initialize({
    email: req.user.email || `${req.user.id}@campusconnect.app`,
    amountGhs: amount, reference, metadata: { userId: req.user.id, purpose },
  });

  return ok(res, {
    reference,
    authorizationUrl: init.authorization_url,
    mock: init.mock === true,
  });
});

// POST /payments/confirm  { reference }  — app calls after returning from Paystack
exports.confirm = asyncHandler(async (req, res) => {
  const { reference } = req.body;
  if (!reference) fail(400, 'reference required');
  const txn = await prisma.paymentTransaction.findUnique({ where: { reference } });
  if (!txn) fail(404, 'Transaction not found');
  if (txn.status === 'PAID') return ok(res, { status: 'PAID', alreadyProcessed: true });

  const result = await payment.verify(reference);
  if (result.status !== 'success') {
    await prisma.paymentTransaction.update({ where: { reference }, data: { status: 'FAILED' } });
    fail(402, 'Payment not successful');
  }
  await settle(txn);
  return ok(res, { status: 'PAID' });
});

// POST /payments/webhook  — Paystack server-to-server
exports.webhook = asyncHandler(async (req, res) => {
  const secret = process.env.PAYSTACK_SECRET_KEY || '';
  if (!secret) {
    // Never accept unsigned webhooks where money moves in production.
    if (isProd) return res.status(503).end();
  } else {
    const raw = req.rawBody || Buffer.from(JSON.stringify(req.body));
    const hash = crypto.createHmac('sha512', secret).update(raw).digest('hex');
    const sig = req.headers['x-paystack-signature'] || '';
    // Constant-time compare to avoid leaking the signature via timing.
    const a = Buffer.from(hash);
    const b = Buffer.from(sig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).end();
  }
  const event = req.body;
  if (event?.event === 'charge.success') {
    const reference = event.data?.reference;
    const txn = await prisma.paymentTransaction.findUnique({ where: { reference } });
    if (txn && txn.status !== 'PAID') await settle(txn);
  }
  res.json({ received: true });
});

// Mark paid + apply the effect (currently: wallet top-up).
async function settle(txn) {
  await prisma.paymentTransaction.update({ where: { reference: txn.reference }, data: { status: 'PAID' } });
  if (txn.purpose === 'TOPUP') {
    await credit(txn.userId, Number(txn.amount), 'TOPUP', { reference: txn.reference });
  }
  logger.info('[Payment] settled', { reference: txn.reference, purpose: txn.purpose });
}
