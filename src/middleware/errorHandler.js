class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

function notFoundHandler(req, res, next) {
  next(new AppError(`Not found: ${req.originalUrl}`, 404));
}

function errorHandler(err, req, res, _next) {
  const statusCode = err.statusCode || 500;
  const message = err.statusCode ? err.message : 'Internal server error';

  if (err.type && String(err.type).startsWith('Stripe')) {
    console.warn('[stripe-error]', {
      path: req.originalUrl,
      method: req.method,
      statusCode,
      type: err.type,
      code: err.code || null,
      message: err.message,
      requestId: err.requestId || err.raw?.requestId || null,
    });
  }

  if (!err.statusCode) {
    console.error('Unhandled error:', err);
  }

  const payload = { success: false, message };
  if (err.details && typeof err.details === 'object') {
    payload.details = err.details;
  }

  res.status(statusCode).json(payload);
}

module.exports = { AppError, notFoundHandler, errorHandler };
