// Uploads — authenticated image upload to local disk, served back over HTTP.
// "Everything local": no cloud bucket required. KYC docs, listing photos,
// vehicle papers and avatars all flow through here and become real, viewable
// URLs (the admin verification screen can actually inspect them).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { asyncHandler, fail, ok } = require('../utils/http');

const UPLOAD_DIR = path.join(__dirname, '../../uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic' };
const MAX_BYTES = 8 * 1024 * 1024; // 8MB

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = ALLOWED[file.mimetype] || path.extname(file.originalname) || '.bin';
    cb(null, `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});

const uploader = multer({
  storage,
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

// POST /uploads  (multipart, field: file) → { url }
exports.create = asyncHandler(async (req, res) => {
  if (!req.file) fail(400, 'No file uploaded (field name must be "file")');
  const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  const url = `${base}/uploads/${req.file.filename}`;
  return ok(res, { url, filename: req.file.filename, size: req.file.size }, 201);
});

exports.single = single;
exports.UPLOAD_DIR = UPLOAD_DIR;
