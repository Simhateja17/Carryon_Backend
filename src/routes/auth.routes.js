const { Router } = require('express');
const { createClient } = require('@supabase/supabase-js');
const prisma = require('../lib/prisma');
const { authenticateToken } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');

const router = Router();
const maskEmail = (email = '') => {
  const [local = '', domain = ''] = String(email).split('@');
  if (!local || !domain) return email;
  const visible = local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(local.length - 2, 1))}@${domain}`;
};

const getBearerToken = (header = '') => {
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.split(' ')[1] || null;
};

// Supabase Admin client for sending OTPs
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

let _supabaseAuthClient;
function getSupabaseAuthClient() {
  if (!_supabaseAuthClient) {
    _supabaseAuthClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      }
    );
  }
  return _supabaseAuthClient;
}

// POST /api/auth/send-otp — Send OTP via Supabase Auth
router.post('/send-otp', async (req, res, next) => {
  const { email, mode = 'login' } = req.body;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('[auth] send-otp failed: invalid email payload', {
      emailProvided: !!email,
      mode,
      path: req.originalUrl,
      ip: req.ip,
    });
    return next(new AppError('A valid email address is required.', 400));
  }

  try {
    console.log(`[auth] send-otp request for ${maskEmail(email)} (mode=${mode})`);

    // Mode-based guards
    if (mode === 'login') {
      const existingUser = await prisma.user.findUnique({ where: { email } });
      if (!existingUser) {
        console.error(`[auth] send-otp blocked: login requested for unknown user ${maskEmail(email)}`);
        return next(new AppError('No account found with this email. Please sign up.', 400));
      }
    } else if (mode === 'signup') {
      const existingUser = await prisma.user.findUnique({ where: { email } });
      if (existingUser) {
        console.error(`[auth] send-otp blocked: signup requested for existing user ${maskEmail(email)}`);
        return next(new AppError('An account with this email already exists. Please log in.', 400));
      }
    }

    // Send OTP via Supabase Auth
    // Always allow Supabase to create the auth user if it doesn't exist — the Prisma
    // mode guard above already enforces login/signup logic. Without this, Supabase
    // silently skips sending the OTP when the user exists in Prisma but not in Supabase Auth.
    const { error } = await getSupabaseAdmin().auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
      },
    });

    if (error) {
      console.error('[auth] send-otp failed: Supabase signInWithOtp error', {
        email: maskEmail(email),
        mode,
        message: error.message,
        status: error.status ?? null,
        code: error.code ?? null,
      });
      return next(new AppError('Failed to send verification code. Please try again.', 500));
    }

    console.log(`[auth] OTP sent to ${maskEmail(email)} via Supabase`);
    res.json({ success: true, message: 'OTP sent successfully.' });
  } catch (err) {
    console.error('[auth] send-otp failed: unexpected error', {
      email: maskEmail(email),
      mode,
      message: err.message,
      stack: err.stack,
    });
    next(err);
  }
});

// POST /api/auth/verify-otp — Verify OTP via Supabase Auth
router.post('/verify-otp', async (req, res, next) => {
  const { email, otp, mode = 'login', name = '' } = req.body;

  if (!email || !otp) {
    console.error('[auth] verify-otp failed: missing required fields', {
      emailProvided: !!email,
      otpProvided: !!otp,
      mode,
      path: req.originalUrl,
      ip: req.ip,
    });
    return next(new AppError('Email and OTP are required.', 400));
  }

  try {
    console.log(`[auth] verify-otp request for ${maskEmail(email)} (mode=${mode})`);

    // Verify OTP with Supabase
    const { data, error } = await getSupabaseAdmin().auth.verifyOtp({
      email,
      token: otp,
      type: 'email',
    });

    if (error) {
      console.error('[auth] verify-otp failed: Supabase verify error', {
        email: maskEmail(email),
        mode,
        message: error.message,
        status: error.status ?? null,
        code: error.code ?? null,
      });
      return next(new AppError('Incorrect or expired code. Please try again.', 400));
    }

    // Get the Supabase session tokens
    const token = data.session?.access_token;
    const refreshToken = data.session?.refresh_token;
    const expiresIn = data.session?.expires_in;
    if (!token || !refreshToken || !expiresIn) {
      console.error('[auth] verify-otp failed: missing session tokens in Supabase response', {
        email: maskEmail(email),
        mode,
        hasSession: !!data.session,
        hasUser: !!data.user,
        hasAccessToken: !!token,
        hasRefreshToken: !!refreshToken,
        hasExpiresIn: expiresIn != null,
      });
      return next(new AppError('Verification failed. Please try again.', 500));
    }

    // Create or find user in Prisma
    let user = await prisma.user.findUnique({ where: { email } });
    const isNewUser = !user;

    if (!user) {
      user = await prisma.user.create({
        data: { email, name, isVerified: true },
      });
      // Create wallet for new user
      await prisma.wallet.create({ data: { userId: user.id } });
    } else {
      await prisma.user.update({ where: { email }, data: { isVerified: true, ...(name ? { name } : {}) } });
      user = await prisma.user.findUnique({ where: { email } });
    }

    console.log(`[auth] OTP verified for ${maskEmail(email)} (mode=${mode})`);
    res.json({
      success: true,
      message: 'OTP verified successfully.',
      token,
      refreshToken,
      expiresIn,
      user,
      isNewUser,
    });
  } catch (err) {
    console.error('[auth] verify-otp failed: unexpected error', {
      email: maskEmail(email),
      mode,
      message: err.message,
      stack: err.stack,
    });
    next(err);
  }
});

// POST /api/auth/refresh — Exchange refresh token for a new session
router.post('/refresh', async (req, res, next) => {
  const { refreshToken } = req.body;

  if (!refreshToken || typeof refreshToken !== 'string') {
    console.error('[auth] refresh failed: missing refresh token', {
      path: req.originalUrl,
      ip: req.ip,
    });
    return next(new AppError('Refresh token is required.', 400));
  }

  try {
    const { data, error } = await getSupabaseAuthClient().auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (error) {
      console.error('[auth] refresh failed: Supabase refresh error', {
        message: error.message,
        status: error.status ?? null,
        code: error.code ?? null,
      });
      return next(new AppError('Session refresh failed. Please log in again.', 401));
    }

    const token = data.session?.access_token;
    const nextRefreshToken = data.session?.refresh_token;
    const expiresIn = data.session?.expires_in;
    if (!token || !nextRefreshToken || !expiresIn) {
      console.error('[auth] refresh failed: missing session tokens in Supabase response', {
        hasSession: !!data.session,
        hasAccessToken: !!token,
        hasRefreshToken: !!nextRefreshToken,
        hasExpiresIn: expiresIn != null,
      });
      return next(new AppError('Session refresh failed. Please log in again.', 401));
    }

    res.json({
      success: true,
      message: 'Session refreshed successfully.',
      token,
      refreshToken: nextRefreshToken,
      expiresIn,
    });
  } catch (err) {
    console.error('[auth] refresh failed: unexpected error', {
      message: err.message,
      stack: err.stack,
    });
    next(err);
  }
});

// POST /api/auth/logout — Revoke current refresh tokens for this session
router.post('/logout', authenticateToken, async (req, res, next) => {
  const accessToken = getBearerToken(req.headers.authorization);
  if (!accessToken) {
    return next(new AppError('Authentication required', 401));
  }

  try {
    const { error } = await getSupabaseAdmin().auth.admin.signOut(accessToken, 'global');

    if (error && ![401, 403, 404].includes(error.status ?? 0)) {
      console.error('[auth] logout failed: Supabase signOut error', {
        email: maskEmail(req.user?.email),
        message: error.message,
        status: error.status ?? null,
        code: error.code ?? null,
      });
      return next(new AppError('Logout failed. Please try again.', 500));
    }

    res.json({ success: true, message: 'Logged out successfully.' });
  } catch (err) {
    console.error('[auth] logout failed: unexpected error', {
      email: maskEmail(req.user?.email),
      message: err.message,
      stack: err.stack,
    });
    next(err);
  }
});

// POST /api/auth/sync — Create or find User by email from Supabase JWT
router.post('/sync', authenticateToken, async (req, res, next) => {
  try {
    const { email } = req.user;
    const { name = '' } = req.body;
    console.log('[auth] POST sync — email:', email);

    let user = await prisma.user.findUnique({ where: { email } });
    const isNewUser = !user;

    if (!user) {
      user = await prisma.user.create({
        data: { email, name, isVerified: true },
      });
      await prisma.wallet.create({ data: { userId: user.id } });
      console.log('[auth] sync — created new user id:', user.id, 'email:', email);
    } else {
      console.log('[auth] sync — found existing user id:', user.id, 'email:', email);
    }

    res.json({ success: true, user, isNewUser });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
