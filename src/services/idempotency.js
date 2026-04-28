// ── Idempotency Module ──────────────────────────────────────
// Owns the Booking creation idempotency interface.

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

function idempotencyKeyFromRequest(req) {
  const raw = req.headers['idempotency-key'];
  return Array.isArray(raw) ? raw[0] : raw;
}

function validateIdempotencyKey(key) {
  if (!key || typeof key !== 'string') return false;
  const normalized = key.trim();
  return normalized.length >= 16 && normalized.length <= 128;
}

function idempotencyExpiresAt(now = new Date()) {
  return new Date(now.getTime() + IDEMPOTENCY_TTL_MS);
}

function isIdempotencyConflict(err) {
  const target = err?.meta?.target;
  if (err?.code !== 'P2002') return false;
  if (Array.isArray(target)) return target.includes('userId') && target.includes('key');
  return typeof target === 'string' && target.includes('IdempotencyKey');
}

module.exports = {
  IDEMPOTENCY_TTL_MS,
  idempotencyKeyFromRequest,
  validateIdempotencyKey,
  idempotencyExpiresAt,
  isIdempotencyConflict,
};
