const { adminAuth } = require('../adminAuth');
const { assertionPayload, signPayload } = require('../../services/adminTrust');

function invokeAdminAuth(headers = {}, overrides = {}) {
  const req = { method: 'GET', originalUrl: '/api/admin/maps/incidents', headers, ...overrides };
  const res = {};
  let nextArg;
  adminAuth(req, res, (err) => {
    nextArg = err;
  });
  return nextArg;
}

describe('adminAuth', () => {
  const originalAdminKey = process.env.ADMIN_API_KEY;
  const originalSigningSecret = process.env.ADMIN_PROXY_SIGNING_SECRET;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.ADMIN_API_KEY = originalAdminKey;
    process.env.ADMIN_PROXY_SIGNING_SECRET = originalSigningSecret;
    process.env.NODE_ENV = originalNodeEnv;
  });

  test('blocks admin requests when server key is not configured', () => {
    delete process.env.ADMIN_API_KEY;

    const err = invokeAdminAuth({ 'x-admin-key': 'provided-key' });

    expect(err.statusCode).toBe(503);
    expect(err.message).toBe('Admin access is not configured');
  });

  test('rejects missing or incorrect admin key', () => {
    process.env.ADMIN_API_KEY = 'correct-admin-key';

    const missing = invokeAdminAuth({});
    const incorrect = invokeAdminAuth({ 'x-admin-key': 'wrong-admin-key' });

    expect(missing.statusCode).toBe(401);
    expect(incorrect.statusCode).toBe(401);
  });

  test('accepts exact configured admin key', () => {
    process.env.ADMIN_API_KEY = 'correct-admin-key';

    const err = invokeAdminAuth({ 'x-admin-key': 'correct-admin-key' });

    expect(err).toBeUndefined();
  });

  test('requires a valid signed assertion for admin panel proxy requests', () => {
    process.env.ADMIN_API_KEY = 'correct-admin-key';
    process.env.ADMIN_PROXY_SIGNING_SECRET = 'proxy-secret';

    const missing = invokeAdminAuth({
      'x-admin-key': 'correct-admin-key',
      'x-admin-proxy': 'admin-panel',
    });

    expect(missing.statusCode).toBe(401);
  });

  test('accepts admin panel proxy requests with signed actor context', () => {
    process.env.ADMIN_API_KEY = 'correct-admin-key';
    process.env.ADMIN_PROXY_SIGNING_SECRET = 'proxy-secret';
    const issuedAt = Date.now();
    const expiresAt = issuedAt + 60_000;
    const payload = assertionPayload({
      method: 'GET',
      pathname: '/api/admin/maps/incidents',
      search: '',
      actorId: 'admin-user-id',
      actorEmail: 'admin@example.com',
      issuedAt,
      expiresAt,
      nonce: 'nonce-1',
    });

    const err = invokeAdminAuth({
      'x-admin-key': 'correct-admin-key',
      'x-admin-proxy': 'admin-panel',
      'x-admin-actor-id': 'admin-user-id',
      'x-admin-actor-email': 'admin@example.com',
      'x-admin-issued-at': String(issuedAt),
      'x-admin-expires-at': String(expiresAt),
      'x-admin-nonce': 'nonce-1',
      'x-admin-signature': signPayload(payload, 'proxy-secret'),
    });

    expect(err).toBeUndefined();
  });

  test('requires a distinct proxy signing secret for admin panel proxy requests in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.ADMIN_API_KEY = 'correct-admin-key';
    delete process.env.ADMIN_PROXY_SIGNING_SECRET;

    const err = invokeAdminAuth({
      'x-admin-key': 'correct-admin-key',
      'x-admin-proxy': 'admin-panel',
    });

    expect(err.statusCode).toBe(401);
  });
});
