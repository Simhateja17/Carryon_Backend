// ── Delivery OTP Handoff Module ─────────────────────────────
// Owns OTP generation, TTL, resend cooldown, verification
// (both admin-stored and Supabase email), and payload shaping.

const { getSupabaseAdmin } = require('../lib/supabase');
const { numericOtp } = require('../lib/otp');
const { maskEmail } = require('../lib/maskEmail');
const {
  DELIVERY_OTP_LENGTH,
  DELIVERY_OTP_TTL_MS,
  DELIVERY_OTP_RESEND_COOLDOWN_MS,
} = require('./businessConfig');

// ── OTP generation ──────────────────────────────────────────

function generateDeliveryOtp() {
  return numericOtp(DELIVERY_OTP_LENGTH);
}

// Short OTP for user-app booking creation
function generatePickupOtp() {
  return numericOtp(4);
}

// ── TTL / Cooldown window ───────────────────────────────────

function addMillis(date, millis) {
  return new Date(date.getTime() + millis);
}

function deliveryOtpWindow(sentAt, now = new Date()) {
  if (!sentAt) {
    return {
      active: false,
      canResend: true,
      expiresAt: null,
      resendAvailableAt: now,
    };
  }
  const sentDate = new Date(sentAt);
  const expiresAt = addMillis(sentDate, DELIVERY_OTP_TTL_MS);
  const resendAvailableAt = addMillis(sentDate, DELIVERY_OTP_RESEND_COOLDOWN_MS);
  return {
    active: now < expiresAt,
    canResend: now >= resendAvailableAt,
    expiresAt,
    resendAvailableAt,
  };
}

function isDeliveryOtpActive(sentAt, now = new Date()) {
  return !!sentAt && now < new Date(new Date(sentAt).getTime() + DELIVERY_OTP_TTL_MS);
}

// ── Payload shaping (for driver app responses) ──────────────

function deliveryOtpPayload({ booking, recipientEmail, now = new Date(), adminOtp = null, alreadySent = false }) {
  const sentAt = booking.deliveryOtpSentAt || now;
  const window = deliveryOtpWindow(sentAt, now);
  return {
    recipientEmail: recipientEmail ? maskEmail(recipientEmail) : '',
    otpSentAt: sentAt.toISOString(),
    otpExpiresAt: window.expiresAt?.toISOString() || addMillis(now, DELIVERY_OTP_TTL_MS).toISOString(),
    resendAvailableAt: window.resendAvailableAt?.toISOString() || now.toISOString(),
    alreadySent,
    adminOtp,
  };
}

// ── Send OTP via Supabase email ─────────────────────────────

async function sendEmailOtp(recipientEmail) {
  const { error } = await getSupabaseAdmin().auth.signInWithOtp({
    email: recipientEmail,
    options: { shouldCreateUser: true },
  });
  if (error) {
    const err = new Error(`Failed to send recipient OTP email: ${error.message}`);
    err.statusCode = 500;
    throw err;
  }
}

// ── Verify OTP ──────────────────────────────────────────────

async function verifyDeliveryOtp({ booking, otp, recipientEmail }) {
  const normalizedOtp = String(otp).trim();
  const isAdminDispatch = booking.dispatchSource === 'ADMIN';

  // Admin-dispatched: check stored OTP
  if (isAdminDispatch) {
    if (!booking.deliveryOtp || booking.deliveryOtp !== normalizedOtp) {
      return { valid: false, error: 'Invalid recipient OTP' };
    }
    return { valid: true };
  }

  // Email-based: verify via Supabase
  if (recipientEmail) {
    const { error } = await getSupabaseAdmin().auth.verifyOtp({
      email: recipientEmail,
      token: normalizedOtp,
      type: 'email',
    });
    if (error) {
      return { valid: false, error: 'Invalid recipient OTP' };
    }
    return { valid: true };
  }

  // Fallback: stored OTP
  if (!booking.deliveryOtp || booking.deliveryOtp !== normalizedOtp) {
    return { valid: false, error: 'Invalid recipient OTP' };
  }
  return { valid: true };
}

// ── User-side verify (booking.routes verify-delivery) ───────

async function verifyUserDeliveryOtp({ booking, otp, recipientEmail }) {
  const normalizedOtp = String(otp).trim();

  if (booking.deliveryOtp) {
    if (booking.deliveryOtp !== normalizedOtp) {
      return { valid: false, error: 'Invalid delivery OTP' };
    }
    return { valid: true };
  }

  // No stored OTP — verify via Supabase
  if (!recipientEmail) {
    return { valid: false, error: 'Recipient email is required to verify delivery OTP' };
  }
  const { error } = await getSupabaseAdmin().auth.verifyOtp({
    email: recipientEmail,
    token: normalizedOtp,
    type: 'email',
  });
  if (error) {
    return { valid: false, error: 'Invalid delivery OTP' };
  }
  return { valid: true };
}

module.exports = {
  generateDeliveryOtp,
  generatePickupOtp,
  deliveryOtpWindow,
  isDeliveryOtpActive,
  maskEmail,
  deliveryOtpPayload,
  sendEmailOtp,
  verifyDeliveryOtp,
  verifyUserDeliveryOtp,
};
