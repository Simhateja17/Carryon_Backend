const {
  ismsDestination,
  parseIsmsResponse,
  sendIsmsSms,
} = require('../ismsSmsProvider');

describe('ismsSmsProvider', () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      ISMS_USERNAME: 'isms-user',
      ISMS_PASSWORD: 'isms-password',
      ISMS_SENDER_ID: 'CarryOn',
      ISMS_SMS_ENDPOINTS: 'https://primary.example.test/send,https://mirror.example.test/send',
      ISMS_SMS_TIMEOUT_MS: '1000',
    };
    global.fetch = jest.fn();
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  test('formats Malaysian phone numbers for iSMS destination format', () => {
    expect(ismsDestination('+60123456789')).toBe('60123456789');
    expect(ismsDestination('012-345 6789')).toBe('60123456789');
  });

  test('treats blank and 2000 responses as successful sends', () => {
    expect(parseIsmsResponse('')).toMatchObject({ ok: true });
    expect(parseIsmsResponse('2000 = SUCCESS:1171081025')).toMatchObject({
      ok: true,
      messageId: '1171081025',
    });
    expect(parseIsmsResponse('20001 = UNKNOWN')).toMatchObject({ ok: false });
  });

  test('posts encoded SMS request and returns the first successful provider result', async () => {
    global.fetch.mockResolvedValue({
      status: 200,
      text: jest.fn().mockResolvedValue('2000 = SUCCESS:abc123'),
    });

    await expect(sendIsmsSms({
      phone: '+60123456789',
      message: 'Your CarryOn verification code is 123456.',
    })).resolves.toMatchObject({
      provider: 'isms',
      endpoint: 'https://primary.example.test/send',
      messageId: 'abc123',
      maskedPhone: '+60*****6789',
    });

    const [endpoint, request] = global.fetch.mock.calls[0];
    expect(endpoint).toBe('https://primary.example.test/send');
    expect(request.method).toBe('POST');
    expect(String(request.body)).toContain('un=isms-user');
    expect(String(request.body)).toContain('pwd=isms-password');
    expect(String(request.body)).toContain('dstno=60123456789');
    expect(String(request.body)).toContain('sendid=CarryOn');
    expect(String(request.body)).toContain('agreedterm=YES');
  });

  test('falls back to mirror endpoint when primary fails', async () => {
    global.fetch
      .mockResolvedValueOnce({
        status: 200,
        text: jest.fn().mockResolvedValue('-1004 = INSUFFICIENT CREDITS'),
      })
      .mockResolvedValueOnce({
        status: 200,
        text: jest.fn().mockResolvedValue('2000 = SUCCESS:mirror-id'),
      });

    await expect(sendIsmsSms({
      phone: '+60123456789',
      message: 'Your CarryOn verification code is 123456.',
    })).resolves.toMatchObject({
      endpoint: 'https://mirror.example.test/send',
      messageId: 'mirror-id',
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('rejects non-HTTPS configured endpoints', async () => {
    process.env.ISMS_SMS_ENDPOINTS = 'http://primary.example.test/send';

    await expect(sendIsmsSms({
      phone: '+60123456789',
      message: 'Your CarryOn verification code is 123456.',
    })).rejects.toThrow('iSMS endpoint must use HTTPS.');
  });

  test('requires a configured sender ID because iSMS requires sendid', async () => {
    delete process.env.ISMS_SENDER_ID;

    await expect(sendIsmsSms({
      phone: '+60123456789',
      message: 'Your CarryOn verification code is 123456.',
    })).rejects.toThrow('iSMS sender ID is not configured.');
  });
});
