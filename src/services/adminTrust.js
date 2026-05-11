const crypto = require('crypto');

const SIGNATURE_HEADER = 'x-admin-signature';
const ACTOR_ID_HEADER = 'x-admin-actor-id';
const ACTOR_EMAIL_HEADER = 'x-admin-actor-email';
const ISSUED_AT_HEADER = 'x-admin-issued-at';
const EXPIRES_AT_HEADER = 'x-admin-expires-at';
const NONCE_HEADER = 'x-admin-nonce';
const REQUEST_ID_HEADER = 'x-admin-request-id';

function signingSecret() {
  if (process.env.ADMIN_PROXY_SIGNING_SECRET) return process.env.ADMIN_PROXY_SIGNING_SECRET;
  return process.env.NODE_ENV === 'production' ? '' : process.env.ADMIN_API_KEY || '';
}

function firstHeader(req, name) {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function splitOriginalUrl(req) {
  const originalUrl = req.originalUrl || req.url || '';
  const queryStart = originalUrl.indexOf('?');
  if (queryStart === -1) return { pathname: originalUrl, search: '' };
  return {
    pathname: originalUrl.slice(0, queryStart),
    search: originalUrl.slice(queryStart),
  };
}

function assertionPayload({ method, pathname, search, actorId, actorEmail, issuedAt, expiresAt, nonce }) {
  return [
    String(method || '').toUpperCase(),
    pathname || '',
    search || '',
    actorId || '',
    actorEmail || '',
    String(issuedAt || ''),
    String(expiresAt || ''),
    nonce || '',
  ].join('\n');
}

function signPayload(payload, secret = signingSecret()) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function timingSafeEqualString(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string') return false;
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function verifyAdminAssertion(req, now = Date.now()) {
  const secret = signingSecret();
  const actorId = firstHeader(req, ACTOR_ID_HEADER);
  const actorEmail = firstHeader(req, ACTOR_EMAIL_HEADER);
  const issuedAt = Number(firstHeader(req, ISSUED_AT_HEADER));
  const expiresAt = Number(firstHeader(req, EXPIRES_AT_HEADER));
  const nonce = firstHeader(req, NONCE_HEADER);
  const signature = firstHeader(req, SIGNATURE_HEADER);
  const requestId = firstHeader(req, REQUEST_ID_HEADER);

  if (!secret) return { ok: false, reason: 'Admin signing secret is not configured' };
  if (!actorId || !actorEmail || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || !nonce || !signature) {
    return { ok: false, reason: 'Missing admin assertion' };
  }
  if (expiresAt <= now || issuedAt > now + 30_000 || expiresAt - issuedAt > 120_000) {
    return { ok: false, reason: 'Expired admin assertion' };
  }

  const { pathname, search } = splitOriginalUrl(req);
  const payload = assertionPayload({
    method: req.method,
    pathname,
    search,
    actorId,
    actorEmail,
    issuedAt,
    expiresAt,
    nonce,
  });
  const expected = signPayload(payload, secret);
  if (!timingSafeEqualString(expected, signature)) {
    return { ok: false, reason: 'Invalid admin assertion' };
  }

  return {
    ok: true,
    actor: {
      actorId,
      actorType: 'ADMIN',
      actorEmail,
      requestId: requestId || null,
    },
  };
}

module.exports = {
  ACTOR_EMAIL_HEADER,
  ACTOR_ID_HEADER,
  EXPIRES_AT_HEADER,
  ISSUED_AT_HEADER,
  NONCE_HEADER,
  REQUEST_ID_HEADER,
  SIGNATURE_HEADER,
  assertionPayload,
  signPayload,
  verifyAdminAssertion,
};
