const { getSupabaseAdmin } = require('../lib/supabase');
const { AppError } = require('../middleware/errorHandler');

const PHONE_DIGITS_MIN = 8;
const PHONE_DIGITS_MAX = 15;

function normalizeEmail(email = '') {
  if (!email || typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

function normalizePhone(value = '') {
  const raw = String(value).trim();
  if (!raw) return '';
  const compact = raw.replace(/[\s().-]/g, '');
  if (compact.startsWith('+')) {
    const digits = compact.slice(1);
    if (/^\d+$/.test(digits) && digits.length >= PHONE_DIGITS_MIN && digits.length <= PHONE_DIGITS_MAX) {
      return `+${digits}`;
    }
    return '';
  }

  const digits = compact.replace(/\D/g, '');
  if (!digits || digits.length < PHONE_DIGITS_MIN || digits.length > PHONE_DIGITS_MAX) return '';

  // CarryOn operates in Malaysia today. Accept common local entries while storing/sending E.164.
  if (digits.startsWith('0')) return `+60${digits.slice(1)}`;
  if (digits.startsWith('60')) return `+${digits}`;
  return '';
}

function maskPhone(phone = '') {
  const normalized = normalizePhone(phone);
  if (!normalized) return '';
  const visible = normalized.slice(-4);
  return `${normalized.slice(0, 3)}*****${visible}`;
}

function phoneLookupVariants(phone = '') {
  const normalized = normalizePhone(phone);
  if (!normalized) return [];
  const variants = new Set([normalized]);
  const digits = normalized.slice(1);
  variants.add(digits);
  if (digits.startsWith('60')) {
    variants.add(`0${digits.slice(2)}`);
  }
  return [...variants];
}

function requirePhone(value, message = 'A valid phone number is required.') {
  const phone = normalizePhone(value);
  if (!phone) throw new AppError(message, 400);
  return phone;
}

async function assertUniquePhone({ prisma, model, phone, excludingEmail = '' }) {
  const variants = phoneLookupVariants(phone);
  const rows = await prisma[model].findMany({
    where: { phone: { in: variants } },
    select: { id: true, email: true },
    take: 2,
  });
  const conflicts = rows.filter(row => !excludingEmail || row.email !== excludingEmail);
  if (conflicts.length > 0) {
    throw new AppError('This phone number is already linked to an account.', 400);
  }
}

async function resolveUniqueByPhone({ prisma, model, phone }) {
  const variants = phoneLookupVariants(phone);
  const rows = await prisma[model].findMany({
    where: { phone: { in: variants } },
    take: 2,
  });
  if (rows.length > 1) {
    throw new AppError('Phone number is linked to multiple accounts. Please contact support.', 401);
  }
  return rows[0] || null;
}

async function sendSmsOtp(phone) {
  const normalizedPhone = requirePhone(phone);
  const { error } = await getSupabaseAdmin().auth.signInWithOtp({
    phone: normalizedPhone,
    options: {
      shouldCreateUser: true,
      channel: 'sms',
    },
  });

  if (error) {
    console.error('[auth-otp] SMS OTP send failed', {
      phone: maskPhone(normalizedPhone),
      message: error.message,
      status: error.status ?? null,
      code: error.code ?? null,
    });
    throw new AppError('Failed to send verification code. Please try again.', 500);
  }

  return { phone: normalizedPhone, maskedPhone: maskPhone(normalizedPhone) };
}

async function verifySmsOtp({ phone, otp }) {
  const normalizedPhone = requirePhone(phone);
  const token = String(otp || '').trim();
  const { data, error } = await getSupabaseAdmin().auth.verifyOtp({
    phone: normalizedPhone,
    token,
    type: 'sms',
  });

  if (error) {
    console.error('[auth-otp] SMS OTP verify failed', {
      phone: maskPhone(normalizedPhone),
      message: error.message,
      status: error.status ?? null,
      code: error.code ?? null,
    });
    throw new AppError('Incorrect or expired code. Please try again.', 400);
  }

  const accessToken = data.session?.access_token;
  const refreshToken = data.session?.refresh_token;
  const expiresIn = data.session?.expires_in;
  if (!accessToken || !refreshToken || !expiresIn) {
    throw new AppError('Verification failed. Please try again.', 500);
  }

  return { token: accessToken, refreshToken, expiresIn, phone: normalizedPhone };
}

module.exports = {
  normalizeEmail,
  normalizePhone,
  phoneLookupVariants,
  maskPhone,
  requirePhone,
  assertUniquePhone,
  resolveUniqueByPhone,
  sendSmsOtp,
  verifySmsOtp,
};
