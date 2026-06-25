// Signed access to PRIVATE media (KYC ID docs / selfies).
//
// KYC files are never public. They are stored under an opaque key (`kyc:<name>`)
// and can only be viewed through a short-lived signed URL minted by an
// authenticated endpoint (admin review queue, or the owner's own status). The
// signature is an HMAC over name+expiry with the server secret, so a leaked
// link is useless after a few minutes and cannot be forged.
const crypto = require('crypto');
const { JWT_SECRET } = require('../config/env');

const KEY_PREFIX = 'kyc:';
const NAME_RE = /^[\w.\-]+$/; // no slashes / traversal

const isKey = (v) => typeof v === 'string' && v.startsWith(KEY_PREFIX);
const keyName = (v) => String(v).slice(KEY_PREFIX.length);
const safeName = (name) => NAME_RE.test(String(name));

function _sig(name, exp) {
  return crypto.createHmac('sha256', JWT_SECRET).update(`${name}.${exp}`).digest('hex');
}

/// A short-lived viewable URL for a private KYC file (default 10 min).
function signedUrl(name, baseUrl, ttlSec = 600) {
  const exp = Date.now() + ttlSec * 1000;
  return `${baseUrl}/media/kyc/${encodeURIComponent(name)}?exp=${exp}&sig=${_sig(name, exp)}`;
}

function verify(name, exp, sig) {
  if (!name || !exp || !sig || !safeName(name)) return false;
  if (Date.now() > Number(exp)) return false;
  const expected = _sig(name, Number(exp));
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { KEY_PREFIX, isKey, keyName, safeName, signedUrl, verify };
