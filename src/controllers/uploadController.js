// Uploads — authenticated image upload. In production, files go to Supabase
// Storage (durable; Railway's own filesystem is ephemeral and would lose them on
// every redeploy). Without Supabase configured, falls back to local disk served
// at /uploads (dev). Either way the caller gets a real, viewable URL — the admin
// verification screen can actually inspect KYC docs.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const logger = require('../config/logger');
const { asyncHandler, fail, ok } = require('../utils/http');
const media = require('../utils/media');

const UPLOAD_DIR = path.join(__dirname, '../../uploads'); // public media
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// KYC docs live here — NEVER served by the public /uploads static handler.
const PRIVATE_DIR = path.join(__dirname, '../../private-uploads');
fs.mkdirSync(PRIVATE_DIR, { recursive: true });

const ALLOWED = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic' };
const MAX_BYTES = 8 * 1024 * 1024; // 8MB

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'campus-uploads';
const supabaseEnabled = SUPABASE_URL.startsWith('http') && SUPABASE_KEY.length > 0;

// Keep the file in memory so we can stream it straight to Supabase (or write to
// disk in dev) without a temp file on disk.
const uploader = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED[file.mimetype]) return cb(Object.assign(new Error('Only JPG, PNG, WEBP or HEIC images are allowed'), { status: 400 }));
    cb(null, true);
  },
});

// Middleware: parse a single multipart `file` field, mapping multer errors to 4xx.
const single = (req, res, next) =>
  uploader.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') err.status = 413, err.message = 'Image must be under 8MB';
    if (!err.status) err.status = 400;
    next(err);
  });

function randomName(file) {
  const ext = ALLOWED[file.mimetype] || path.extname(file.originalname) || '.bin';
  return `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`;
}

async function putSupabase(file, objectPath) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${objectPath}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_KEY}`,
      apikey: SUPABASE_KEY,
      'Content-Type': file.mimetype,
      'x-upsert': 'true',
      'cache-control': '2592000',
    },
    body: file.buffer,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.error('[Upload] Supabase storage error', { status: res.status, body: body.slice(0, 200) });
    throw Object.assign(new Error('Upload failed'), { status: 502 });
  }
}

function saveToDisk(dir, name, file) {
  fs.writeFileSync(path.join(dir, name), file.buffer);
}

// Turn a stored KYC key (`kyc:<name>`) into a short-lived viewable URL:
// a Supabase signed URL in prod, or our own signed /media route on local disk.
async function resolveKyc(key, baseUrl) {
  if (!media.isKey(key)) return key; // already a plain URL (back-compat) or empty
  const name = media.keyName(key);
  if (!media.safeName(name)) return null;
  if (supabaseEnabled) {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${SUPABASE_BUCKET}/kyc/${name}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: 600 }),
    });
    const data = await res.json().catch(() => null);
    return data && data.signedURL ? `${SUPABASE_URL}/storage/v1${data.signedURL}` : null;
  }
  return media.signedUrl(name, baseUrl);
}

// Replace any KYC keys on a verification record with fresh signed URLs for viewing.
async function withSignedDocs(record, baseUrl) {
  const out = { ...record };
  for (const f of ['idFrontUrl', 'idBackUrl', 'selfieUrl']) {
    if (media.isKey(out[f])) out[f] = await resolveKyc(out[f], baseUrl);
  }
  return out;
}

// POST /uploads  (multipart, field: file; optional body purpose=kyc) → { url } or { key }
exports.create = asyncHandler(async (req, res) => {
  if (!req.file) fail(400, 'No file uploaded (field name must be "file")');
  const name = randomName(req.file);

  // KYC docs are private: stored off the public path, returned as an opaque key.
  if (req.body && req.body.purpose === 'kyc') {
    if (supabaseEnabled) {
      await putSupabase(req.file, `kyc/${name}`);
    } else {
      saveToDisk(PRIVATE_DIR, name, req.file);
    }
    return ok(res, { key: `${media.KEY_PREFIX}${name}`, filename: name, size: req.file.size }, 201);
  }

  let url;
  if (supabaseEnabled) {
    await putSupabase(req.file, `uploads/${name}`);
    url = `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/uploads/${name}`;
  } else {
    saveToDisk(UPLOAD_DIR, name, req.file);
    const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    url = `${base}/uploads/${name}`;
  }
  return ok(res, { url, filename: name, size: req.file.size }, 201);
});

// GET /media/kyc/:name?exp&sig — stream a private KYC file when the signed token
// is valid. (In Supabase mode, viewers get a Supabase signed URL instead and this
// route is unused.)
exports.serveKyc = (req, res) => {
  const { name } = req.params;
  const { exp, sig } = req.query;
  if (!media.verify(name, exp, sig)) return res.status(401).send('Forbidden');
  const file = path.join(PRIVATE_DIR, path.basename(name));
  if (!fs.existsSync(file)) return res.status(404).send('Not found');
  return res.sendFile(file);
};

exports.single = single;
exports.UPLOAD_DIR = UPLOAD_DIR;
exports.PRIVATE_DIR = PRIVATE_DIR;
exports.supabaseEnabled = supabaseEnabled;
exports.resolveKyc = resolveKyc;
exports.withSignedDocs = withSignedDocs;
