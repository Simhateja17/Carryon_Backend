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

  if (!err.statusCode) {
    console.error('Unhandled error:', err);
  }

  res.status(statusCode).json({ success: false, message });
}

module.exports = { AppError, notFoundHandler, errorHandler };
