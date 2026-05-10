const { adminAuth } = require('../adminAuth');

function invokeAdminAuth(headers = {}) {
  const req = { headers };
  const res = {};
  let nextArg;
  adminAuth(req, res, (err) => {
    nextArg = err;
  });
  return nextArg;
}

describe('adminAuth', () => {
  const originalAdminKey = process.env.ADMIN_API_KEY;

  afterEach(() => {
    process.env.ADMIN_API_KEY = originalAdminKey;
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
});
