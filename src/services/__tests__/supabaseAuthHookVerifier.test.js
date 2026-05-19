const crypto = require('crypto');
const {
  decodeWebhookSecret,
  verifySupabaseAuthHook,
} = require('../supabaseAuthHookVerifier');

function signedRequest({ secret, payload, timestamp = 1_800_000_000 }) {
  const rawBody = JSON.stringify(payload);
  const id = 'msg_test';
  const decodedSecret = decodeWebhookSecret(secret);
  const signature = crypto
    .createHmac('sha256', decodedSecret)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest('base64');

  return {
    rawBody: Buffer.from(rawBody),
    headers: {
      'webhook-id': id,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': `v1,${signature}`,
    },
  };
}

describe('supabaseAuthHookVerifier', () => {
  const originalSecret = process.env.SUPABASE_AUTH_HOOK_SECRET;
  const hookSecret = `whsec_${Buffer.from('test-secret').toString('base64')}`;

  afterEach(() => {
    process.env.SUPABASE_AUTH_HOOK_SECRET = originalSecret;
  });

  test('accepts a valid standard webhook signature', () => {
    process.env.SUPABASE_AUTH_HOOK_SECRET = hookSecret;
    const req = signedRequest({
      secret: hookSecret,
      payload: { user: { phone: '+60123456789' }, sms: { otp: '123456' } },
    });

    expect(verifySupabaseAuthHook(req, { now: () => 1_800_000_000_000 })).toBe(true);
  });

  test('rejects requests when the hook secret is missing', () => {
    delete process.env.SUPABASE_AUTH_HOOK_SECRET;
    const req = signedRequest({
      secret: hookSecret,
      payload: { user: { phone: '+60123456789' }, sms: { otp: '123456' } },
    });

    expect(() => verifySupabaseAuthHook(req, { now: () => 1_800_000_000_000 }))
      .toThrow('Supabase auth hook is not configured.');
  });

  test('rejects invalid signatures', () => {
    process.env.SUPABASE_AUTH_HOOK_SECRET = hookSecret;
    const req = signedRequest({
      secret: hookSecret,
      payload: { user: { phone: '+60123456789' }, sms: { otp: '123456' } },
    });
    req.headers['webhook-signature'] = 'v1,invalid';

    expect(() => verifySupabaseAuthHook(req, { now: () => 1_800_000_000_000 }))
      .toThrow('Invalid Supabase auth hook signature.');
  });

  test('rejects expired signatures', () => {
    process.env.SUPABASE_AUTH_HOOK_SECRET = hookSecret;
    const req = signedRequest({
      secret: hookSecret,
      payload: { user: { phone: '+60123456789' }, sms: { otp: '123456' } },
      timestamp: 1_800_000_000,
    });

    expect(() => verifySupabaseAuthHook(req, { now: () => 1_800_001_000_000 }))
      .toThrow('Expired Supabase auth hook signature.');
  });
});
