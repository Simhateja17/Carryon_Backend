jest.mock('../../lib/supabase', () => ({
  getSupabaseAdmin: jest.fn(),
}));

const { getSupabaseAdmin } = require('../../lib/supabase');
const {
  normalizePhone,
  maskPhone,
  phoneLookupVariants,
  assertUniquePhone,
  sendSmsOtp,
  verifySmsOtp,
} = require('../authOtp');

describe('authOtp', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('normalizes Malaysian phone numbers to E.164', () => {
    expect(normalizePhone('+60123456789')).toBe('+60123456789');
    expect(normalizePhone('012-345 6789')).toBe('+60123456789');
    expect(normalizePhone('60123456789')).toBe('+60123456789');
    expect(normalizePhone('12345')).toBe('');
  });

  test('masks phone numbers without exposing full recipient', () => {
    expect(maskPhone('+60123456789')).toBe('+60*****6789');
  });

  test('builds lookup variants for existing local-format records', () => {
    expect(phoneLookupVariants('+60123456789')).toEqual([
      '+60123456789',
      '60123456789',
      '0123456789',
    ]);
  });

  test('rejects phone numbers already linked to another account', async () => {
    const prisma = {
      user: {
        findMany: jest.fn().mockResolvedValue([{ id: 'user-1', email: 'taken@example.com' }]),
      },
    };

    await expect(assertUniquePhone({ prisma, model: 'user', phone: '+60123456789' }))
      .rejects
      .toMatchObject({ statusCode: 400 });
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { phone: { in: ['+60123456789', '60123456789', '0123456789'] } },
      select: { id: true, email: true },
      take: 2,
    });
  });

  test('sends SMS OTP through Supabase phone auth', async () => {
    const signInWithOtp = jest.fn().mockResolvedValue({ error: null });
    getSupabaseAdmin.mockReturnValue({ auth: { signInWithOtp } });

    await expect(sendSmsOtp('+60123456789')).resolves.toMatchObject({
      phone: '+60123456789',
      maskedPhone: '+60*****6789',
    });
    expect(signInWithOtp).toHaveBeenCalledWith({
      phone: '+60123456789',
      options: {
        shouldCreateUser: true,
        channel: 'sms',
      },
    });
  });

  test('returns session tokens after SMS OTP verification', async () => {
    const verifyOtp = jest.fn().mockResolvedValue({
      data: {
        session: {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
        },
      },
      error: null,
    });
    getSupabaseAdmin.mockReturnValue({ auth: { verifyOtp } });

    await expect(verifySmsOtp({ phone: '+60123456789', otp: '123456' })).resolves.toEqual({
      token: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 3600,
      phone: '+60123456789',
    });
    expect(verifyOtp).toHaveBeenCalledWith({
      phone: '+60123456789',
      token: '123456',
      type: 'sms',
    });
  });
});
