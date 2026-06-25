// Paystack integration — activates automatically when PAYSTACK_SECRET_KEY is set.
// Falls back to a local "mock" mode for development without credentials.
const logger = require('../config/logger');

const SECRET = process.env.PAYSTACK_SECRET_KEY || '';
const enabled = SECRET.startsWith('sk_');

function isEnabled() {
  return enabled;
}

// Mock mode is a dev convenience only — it must NEVER run in production, where a
// real provider is mandatory (otherwise top-ups/refunds would "succeed" for free).
function assertUsable() {
  if (!enabled && process.env.NODE_ENV === 'production') {
    throw Object.assign(new Error('Payments are not configured'), { status: 503 });
  }
}

// Initialize a transaction → returns an authorization URL the app opens.
async function initialize({ email, amountGhs, reference, metadata }) {
  assertUsable();
  if (!enabled) {
    logger.info('[Payment] mock initialize', { reference, amountGhs });
    return { mock: true, reference, authorization_url: null };
  }
  const res = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, amount: Math.round(amountGhs * 100), reference, metadata, currency: 'GHS' }),
  });
  const data = await res.json();
  if (!data.status) throw Object.assign(new Error(data.message || 'Paystack init failed'), { status: 502 });
  return data.data; // { authorization_url, access_code, reference }
}

// Verify a transaction by reference.
async function verify(reference) {
  assertUsable();
  if (!enabled) return { status: 'success', mock: true, reference };
  const res = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  const data = await res.json();
  return data.data || { status: 'failed' };
}

module.exports = { isEnabled, initialize, verify };
