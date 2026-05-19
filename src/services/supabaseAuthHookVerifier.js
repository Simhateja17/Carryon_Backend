const crypto = require('crypto');
const { AppError } = require('../middleware/errorHandler');

const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function decodeWebhookSecret(secret) {
  const value = String(secret || '').trim();
  if (!value) return null;
  const encoded = value.startsWith('whsec_') ? value.slice('whsec_'.length) : value;
  try {
    return Buffer.from(encoded, 'base64');
  } catch (_err) {
    return Buffer.from(value);
  }
}

function configuredSecrets() {
  return String(process.env.SUPABASE_AUTH_HOOK_SECRET || '')
    .split(',')
    .map(decodeWebhookSecret)
    .filter(Boolean);
}

function signaturesFromHeader(value = '') {
  return String(value)
    .split(/\s+/)
    .flatMap((part) => part.split(','))
    .map((part) => part.trim())
    .filter((part) => part && part !== 'v1');
}

function rawRequestBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody.toString('utf8');
  if (typeof req.rawBody === 'string') return req.rawBody;
  throw new AppError('Signed hook payload is unavailable.', 400);
}

function verifySupabaseAuthHook(req, { now = Date.now } = {}) {
  const secrets = configuredSecrets();
  if (secrets.length === 0) {
    throw new AppError('Supabase auth hook is not configured.', 503);
  }

  const id = req.headers['webhook-id'];
  const timestamp = req.headers['webhook-timestamp'];
  const signatureHeader = req.headers['webhook-signature'];
  if (!id || !timestamp || !signatureHeader) {
    throw new AppError('Missing Supabase auth hook signature.', 401);
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    throw new AppError('Invalid Supabase auth hook timestamp.', 401);
  }

  const ageSeconds = Math.abs(Math.floor(now() / 1000) - timestampSeconds);
  if (ageSeconds > DEFAULT_TOLERANCE_SECONDS) {
    throw new AppError('Expired Supabase auth hook signature.', 401);
  }

  const payload = rawRequestBody(req);
  const signedPayload = `${id}.${timestamp}.${payload}`;
  const signatures = signaturesFromHeader(signatureHeader);
  const verified = secrets.some((secret) => {
    const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('base64');
    return signatures.some((signature) => timingSafeEqualString(signature, expected));
  });

  if (!verified) {
    throw new AppError('Invalid Supabase auth hook signature.', 401);
  }

  return true;
}

module.exports = {
  decodeWebhookSecret,
  verifySupabaseAuthHook,
};
