// Coupons — validate & redeem.
const prisma = require('../config/database');
const { asyncHandler, fail, ok } = require('../utils/http');

function discountFor(coupon, amount) {
  if (coupon.type === 'PERCENT') return Math.round(amount * (Number(coupon.value) / 100) * 100) / 100;
  return Math.min(Number(coupon.value), amount);
}

// POST /coupons/validate  { code, amount, context? }
exports.validate = asyncHandler(async (req, res) => {
  const { code, amount, context } = req.body;
  if (!code) fail(400, 'code required');
  const coupon = await prisma.coupon.findUnique({ where: { code: code.toUpperCase() } });
  if (!coupon || !coupon.isActive) fail(404, 'Invalid coupon');
  if (coupon.expiresAt && coupon.expiresAt < new Date()) fail(410, 'Coupon expired');
  if (coupon.appliesTo && coupon.appliesTo !== 'ALL' && context && coupon.appliesTo !== context) fail(400, `Coupon only valid for ${coupon.appliesTo}`);
  const amt = parseFloat(amount || 0);
  if (coupon.minSpend && amt < Number(coupon.minSpend)) fail(400, `Minimum spend is ${coupon.minSpend}`);

  const used = await prisma.couponRedemption.count({ where: { couponCode: coupon.code, userId: req.user.id } });
  if (used >= coupon.perUserLimit) fail(409, 'Coupon usage limit reached');

  return ok(res, { code: coupon.code, discount: discountFor(coupon, amt), type: coupon.type, value: Number(coupon.value) });
});

// POST /coupons/redeem  { code, amount, contextType?, contextId? }
exports.redeem = asyncHandler(async (req, res) => {
  const { code, amount, contextType, contextId } = req.body;
  const coupon = await prisma.coupon.findUnique({ where: { code: (code || '').toUpperCase() } });
  if (!coupon || !coupon.isActive) fail(404, 'Invalid coupon');
  const discount = discountFor(coupon, parseFloat(amount || 0));
  const redemption = await prisma.couponRedemption.create({
    data: { couponCode: coupon.code, userId: req.user.id, amount: discount, contextType, contextId },
  });
  return ok(res, { redemption, discount }, 201);
});
