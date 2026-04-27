// ── Delivery OTP Handoff Module ─────────────────────────────
// Owns OTP generation, TTL, resend cooldown, verification
// (both admin-stored and Supabase email), and payload shaping.

const { createClient } = require('@supabase/supabase-js');
const {
  DELIVERY_OTP_LENGTH,
  DELIVERY_OTP_TTL_MS,
  DELIVERY_OTP_RESEND_COOLDOWN_MS,
} = require('./businessConfig');

// ── Supabase admin client (lazy) ────────────────────────────

let _supabaseAdmin;
function getSupabaseAdmin() {
  if (!_supabaseAdmin) {
    _supabaseAdmin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
  }
  return _supabaseAdmin;
}

// ── OTP generation ──────────────────────────────────────────

function generateDeliveryOtp() {
  return Math.floor(
    10 ** (DELIVERY_OTP_LENGTH - 1) + Math.random() * 9 * 10 ** (DELIVERY_OTP_LENGTH - 1)
  ).toString();
}

// Short OTP for user-app booking creation
function generatePickupOtp() {
  return Math.floor(1000 + Math.random() * 9000).toString();
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

// ── Email masking ───────────────────────────────────────────

function maskEmail(email = '') {
  const [local = '', domain = ''] = String(email).split('@');
  if (!local || !domain) return email;
  const visible = local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(local.length - 2, 1))}@${domain}`;
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
