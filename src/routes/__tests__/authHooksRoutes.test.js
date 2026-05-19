const crypto = require('crypto');

jest.mock('../../services/authSmsDelivery', () => ({
  sendAuthOtpSms: jest.fn().mockResolvedValue({ provider: 'isms' }),
}));

const { sendAuthOtpSms } = require('../../services/authSmsDelivery');
const { decodeWebhookSecret } = require('../../services/supabaseAuthHookVerifier');
const router = require('../auth-hooks.routes');

function signHookPayload({ secret, body, timestamp = 1_800_000_000 }) {
  const rawBody = JSON.stringify(body);
  const id = 'msg_route_test';
  const signature = crypto
    .createHmac('sha256', decodeWebhookSecret(secret))
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

async function invokeRoute(reqOverrides = {}) {
  const req = {
    method: 'POST',
    originalUrl: '/send-sms',
    params: {},
    body: {},
    query: {},
    headers: {},
    ...reqOverrides,
  };
  let statusCode = 200;
  let responseBody;
  let ended = false;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      ended = true;
      return this;
    },
    end() {
      ended = true;
      return this;
    },
  };

  const routeLayer = router.stack.find((layer) => (
    layer.route &&
    layer.route.path === '/send-sms' &&
    layer.route.methods.post
  ));
  if (!routeLayer) throw new Error('Route not found: POST /send-sms');

  for (const handlerLayer of routeLayer.route.stack) {
    if (ended) break;
    const handler = handlerLayer.handle;
    await handler(req, res, () => {});
  }

  return { status: statusCode, body: responseBody };
}

describe('auth hook routes', () => {
  const originalSecret = process.env.SUPABASE_AUTH_HOOK_SECRET;
  const hookSecret = `whsec_${Buffer.from('route-secret').toString('base64')}`;

  beforeEach(() => {
    process.env.SUPABASE_AUTH_HOOK_SECRET = hookSecret;
    jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  });

  afterEach(() => {
    process.env.SUPABASE_AUTH_HOOK_SECRET = originalSecret;
    Date.now.mockRestore();
    jest.clearAllMocks();
  });

  test('accepts a signed Supabase Send SMS hook payload', async () => {
    const body = { user: { phone: '+60123456789' }, sms: { otp: '123456' } };
    const signed = signHookPayload({ secret: hookSecret, body });

    const response = await invokeRoute({ body, ...signed });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({});
    expect(sendAuthOtpSms).toHaveBeenCalledWith(body);
  });

  test('rejects unsigned hook payloads', async () => {
    const response = await invokeRoute({
      body: { user: { phone: '+60123456789' }, sms: { otp: '123456' } },
      rawBody: Buffer.from('{}'),
    });

    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe('Missing Supabase auth hook signature.');
    expect(sendAuthOtpSms).not.toHaveBeenCalled();
  });
});
