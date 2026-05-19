jest.mock('../ismsSmsProvider', () => ({
  sendIsmsSms: jest.fn().mockResolvedValue({
    provider: 'isms',
    messageId: 'message-id',
    maskedPhone: '+60*****6789',
  }),
}));

const { sendIsmsSms } = require('../ismsSmsProvider');
const {
  extractAuthSmsPayload,
  otpMessage,
  sendAuthOtpSms,
} = require('../authSmsDelivery');

describe('authSmsDelivery', () => {
  const originalTemplate = process.env.AUTH_SMS_OTP_TEMPLATE;

  afterEach(() => {
    process.env.AUTH_SMS_OTP_TEMPLATE = originalTemplate;
    jest.clearAllMocks();
  });

  test('extracts phone and OTP from Supabase Send SMS hook payload', () => {
    expect(extractAuthSmsPayload({
      user: { phone: '+60123456789' },
      sms: { otp: '123456' },
    })).toEqual({
      phone: '+60123456789',
      otp: '123456',
    });
  });

  test('rejects malformed OTP payloads', () => {
    expect(() => extractAuthSmsPayload({
      user: { phone: '+60123456789' },
      sms: { otp: '12345' },
    })).toThrow('Supabase auth hook payload is missing a valid OTP.');
  });

  test('uses configured OTP message template', () => {
    process.env.AUTH_SMS_OTP_TEMPLATE = 'Code: {{otp}}';
    expect(otpMessage('123456')).toBe('Code: 123456');
  });

  test('sends auth OTP through the iSMS adapter', async () => {
    process.env.AUTH_SMS_OTP_TEMPLATE = 'Code: {{otp}}';

    await sendAuthOtpSms({
      user: { phone: '+60123456789' },
      sms: { otp: '123456' },
    });

    expect(sendIsmsSms).toHaveBeenCalledWith({
      phone: '+60123456789',
      message: 'Code: 123456',
    });
  });
});
