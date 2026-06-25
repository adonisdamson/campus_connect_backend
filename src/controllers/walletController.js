// Wallet — balance, transactions, top-up (mock), payout request.
const prisma = require('../config/database');
const { asyncHandler, fail, ok } = require('../utils/http');
const { isProd } = require('../config/env');
const { credit, debit, getOrCreate } = require('../services/wallet');

// GET /wallet
exports.get = asyncHandler(async (req, res) => {
  const wallet = await getOrCreate(req.user.id);
  const transactions = await prisma.walletTransaction.findMany({
    where: { walletId: wallet.id }, orderBy: { createdAt: 'desc' }, take: 50,
  });
  return ok(res, { balance: Number(wallet.balance), escrowBalance: Number(wallet.escrowBalance), currency: wallet.currency, transactions });
});

// POST /wallet/topup  { amount }
// When Paystack is configured, returns an authorization URL to open. Otherwise
// (dev / no keys) credits the wallet instantly so the flow is testable.
exports.topup = asyncHandler(async (req, res) => {
  const amount = parseFloat(req.body.amount);
  if (!(amount > 0)) fail(400, 'amount must be positive');

  const payment = require('../services/payment');
  if (payment.isEnabled()) {
    const crypto = require('crypto');
    const reference = `CC_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    await prisma.paymentTransaction.create({
      data: { userId: req.user.id, method: 'MTN_MOMO', amount, reference, purpose: 'TOPUP', status: 'PENDING' },
    });
    const init = await payment.initialize({
      email: req.user.email || `${req.user.id}@campusconnect.app`, amountGhs: amount, reference,
    });
    return ok(res, { pending: true, reference, authorizationUrl: init.authorization_url });
  }

  // No payment provider configured. Instant-crediting real money is a dev-only
  // convenience — never let it run in production.
  if (isProd) fail(503, 'Payments are not configured');
  const txn = await credit(req.user.id, amount, 'TOPUP', { reference: 'DEV-' + Date.now() });
  const wallet = await getOrCreate(req.user.id);
  return ok(res, { balance: Number(wallet.balance), transaction: txn });
});

// POST /wallet/payout  { amount, momoNumber, network }
exports.payout = asyncHandler(async (req, res) => {
  const { amount, momoNumber, network } = req.body;
  const amt = parseFloat(amount);
  if (!(amt > 0)) fail(400, 'amount must be positive');
  if (!momoNumber || !network) fail(400, 'momoNumber and network required');
  // Debit immediately (atomic, throws 402 if short) so the funds are held for the
  // payout — prevents requesting more than the balance or double-spending after.
  await debit(req.user.id, amt, 'PAYOUT', { contextType: 'PAYOUT' });
  const request = await prisma.payoutRequest.create({ data: { userId: req.user.id, amount: amt, momoNumber, network } });
  return ok(res, { payout: request, message: 'Payout requested — processed within 24h' }, 201);
});
