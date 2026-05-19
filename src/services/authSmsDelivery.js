const { AppError } = require('../middleware/errorHandler');
const { isValidOtp, normalizeOtp } = require('../lib/otp');
const { maskPhone, requirePhone } = require('./authOtp');
const { sendIsmsSms } = require('./ismsSmsProvider');

function otpMessage(otp) {
  const template = process.env.AUTH_SMS_OTP_TEMPLATE || 'Your CarryOn verification code is {{otp}}.';
  return template.replaceAll('{{otp}}', otp);
}

function extractAuthSmsPayload(event = {}) {
  const phone = requirePhone(event.user?.phone, 'Supabase auth hook payload is missing a valid phone number.');
  const otp = normalizeOtp(event.sms?.otp);
  if (!isValidOtp(otp)) {
    throw new AppError('Supabase auth hook payload is missing a valid OTP.', 400);
  }
  return { phone, otp };
}

async function sendAuthOtpSms(event) {
  const { phone, otp } = extractAuthSmsPayload(event);
  const result = await sendIsmsSms({
    phone,
    message: otpMessage(otp),
  });
  console.log('[auth-sms-delivery] OTP SMS sent', {
    provider: result.provider,
    phone: maskPhone(phone),
    messageId: result.messageId || null,
  });
  return result;
}

module.exports = {
  extractAuthSmsPayload,
  otpMessage,
  sendAuthOtpSms,
};
