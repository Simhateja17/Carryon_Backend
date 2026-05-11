const crypto = require('crypto');
const { AppError } = require('./errorHandler');
const { verifyAdminAssertion } = require('../services/adminTrust');

/**
 * Admin authentication middleware.
 * Validates the x-admin-key header against ADMIN_API_KEY env variable.
 * If ADMIN_API_KEY is not set, all admin requests are rejected.
 */
function adminAuth(req, res, next) {
  const adminKey = process.env.ADMIN_API_KEY;

  if (!adminKey) {
    console.error('[adminAuth] ADMIN_API_KEY is not configured — blocking request');
    return next(new AppError('Admin access is not configured', 503));
  }

  const providedKey = req.headers['x-admin-key'];

  if (!providedKey || typeof providedKey !== 'string') {
    return next(new AppError('Unauthorized: invalid or missing admin key', 401));
  }

  const expected = Buffer.from(adminKey);
  const provided = Buffer.from(providedKey);

  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    return next(new AppError('Unauthorized: invalid or missing admin key', 401));
  }

  if (req.headers['x-admin-proxy'] === 'admin-panel') {
    const assertion = verifyAdminAssertion(req);
    if (!assertion.ok) {
      console.error('[adminAuth] Assertion failed:', assertion.reason, {
        method: req.method,
        originalUrl: req.originalUrl,
        hasSignature: !!req.headers['x-admin-signature'],
        hasActorId: !!req.headers['x-admin-actor-id'],
        hasIssuedAt: !!req.headers['x-admin-issued-at'],
        hasExpiresAt: !!req.headers['x-admin-expires-at'],
        hasNonce: !!req.headers['x-admin-nonce'],
        signingSecretPrefix: process.env.ADMIN_PROXY_SIGNING_SECRET ? process.env.ADMIN_PROXY_SIGNING_SECRET.slice(0, 6) : 'NOT_SET',
      });
      return next(new AppError('Unauthorized: invalid admin assertion', 401));
    }
    req.adminActor = assertion.actor;
    return next();
  }

  req.adminActor = {
    actorId: 'admin-key',
    actorType: 'ADMIN',
    actorEmail: null,
    requestId: null,
  };
  next();
}

module.exports = { adminAuth };
