// Small HTTP helpers shared across controllers.

// Wrap an async route handler so thrown errors hit the error middleware.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Throw a typed HTTP error (caught by errorHandler).
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};

const ok = (res, data = {}, status = 200) => res.status(status).json({ success: true, ...data });

module.exports = { asyncHandler, HttpError, fail, ok };
