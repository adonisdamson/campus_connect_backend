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

const UPLOAD_DIR = path.join(__dirname, '../../uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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

async function uploadToSupabase(file, name) {
  const objectPath = `uploads/${name}`;
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
  return `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${objectPath}`;
}

function saveToDisk(file, name) {
  fs.writeFileSync(path.join(UPLOAD_DIR, name), file.buffer);
}

// POST /uploads  (multipart, field: file) → { url }
exports.create = asyncHandler(async (req, res) => {
  if (!req.file) fail(400, 'No file uploaded (field name must be "file")');
  const name = randomName(req.file);

  let url;
  if (supabaseEnabled) {
    url = await uploadToSupabase(req.file, name);
  } else {
    saveToDisk(req.file, name);
    const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    url = `${base}/uploads/${name}`;
  }
  return ok(res, { url, filename: name, size: req.file.size }, 201);
});

exports.single = single;
exports.UPLOAD_DIR = UPLOAD_DIR;
exports.supabaseEnabled = supabaseEnabled;
