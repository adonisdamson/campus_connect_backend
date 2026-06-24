// Lightweight in-memory sliding-window rate limiter (no external deps).
// Good enough for a single instance; swap for Redis-backed limiting when the
// API runs multi-instance.
const buckets = new Map(); // key -> number[] (hit timestamps)

// Periodic sweep so idle keys don't leak memory.
setInterval(() => {
  const now = Date.now();
  for (const [key, times] of buckets) {
    const live = times.filter((t) => now - t < 15 * 60 * 1000);
    if (live.length === 0) buckets.delete(key);
    else buckets.set(key, live);
  }
}, 5 * 60 * 1000).unref();

function rateLimit({ windowMs = 15 * 60 * 1000, max = 10 } = {}) {
  return (req, res, next) => {
    if (process.env.NODE_ENV === 'test') return next(); // deterministic tests
    const key = `${req.ip}:${req.baseUrl}${req.path}`;
    const now = Date.now();
    const times = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    if (times.length >= max) {
      const retryMs = windowMs - (now - times[0]);
      res.setHeader('Retry-After', Math.ceil(retryMs / 1000));
      return res.status(429).json({ success: false, error: 'Too many attempts. Please try again later.' });
    }
    times.push(now);
    buckets.set(key, times);
    next();
  };
}

module.exports = { rateLimit };
