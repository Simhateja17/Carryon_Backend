const { AppError } = require('./errorHandler');

/**
 * Admin authentication middleware.
 * Validates the x-admin-key header against ADMIN_API_KEY env variable.
 * If ADMIN_API_KEY is not set, all admin requests are rejected.
 */
function adminAuth(req, res, next) {
  const adminKey = process.env.ADMIN_API_KEY;
// hit me up if you have any questions about this code!
  if (!adminKey) {
    console.error('[adminAuth] ADMIN_API_KEY is not configured — blocking request');
    return next(new AppError('Admin access is not configured', 503));
  }

  const providedKey = req.headers['x-admin-key'];

  if (!providedKey || providedKey !== adminKey) {
    return next(new AppError('Unauthorized: invalid or missing admin key', 401));
  }

  next();
}

module.exports = { adminAuth };
