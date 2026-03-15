const { Router } = require('express');
const { createClient } = require('@supabase/supabase-js');
const prisma = require('../lib/prisma');
const { authenticateToken } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');

const router = Router();

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

// POST /api/auth/send-otp — Send OTP via Supabase Auth
router.post('/send-otp', async (req, res, next) => {
  const { email, mode = 'login' } = req.body;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return next(new AppError('A valid email address is required.', 400));
  }

  try {
    console.log(`[auth] send-otp request for ${email} (mode=${mode})`);

    // Mode-based guards
    if (mode === 'login') {
      const existingUser = await prisma.user.findUnique({ where: { email } });
      if (!existingUser) {
        return next(new AppError('No account found with this email. Please sign up.', 400));
      }
    } else if (mode === 'signup') {
      const existingUser = await prisma.user.findUnique({ where: { email } });
      if (existingUser) {
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
      console.error(`[auth] Supabase OTP error:`, error.message);
      return next(new AppError('Failed to send verification code. Please try again.', 500));
    }

    console.log(`[auth] OTP sent to ${email} via Supabase`);
    res.json({ success: true, message: 'OTP sent successfully.' });
  } catch (err) {
    console.error(`[auth] send-otp failed for ${email}:`, err.message);
    next(err);
  }
});

// POST /api/auth/verify-otp — Verify OTP via Supabase Auth
router.post('/verify-otp', async (req, res, next) => {
  const { email, otp, mode = 'login', name = '' } = req.body;

  if (!email || !otp) {
    return next(new AppError('Email and OTP are required.', 400));
  }

  try {
    console.log(`[auth] verify-otp request for ${email} (mode=${mode})`);

    // Verify OTP with Supabase
    const { data, error } = await getSupabaseAdmin().auth.verifyOtp({
      email,
      token: otp,
      type: 'email',
    });

    if (error) {
      console.error(`[auth] Supabase verify error:`, error.message);
      return next(new AppError('Incorrect or expired code. Please try again.', 400));
    }

    // Get the Supabase session token
    const token = data.session?.access_token;
    if (!token) {
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

    console.log(`[auth] OTP verified for ${email} (mode=${mode})`);
    res.json({ success: true, message: 'OTP verified successfully.', token, user, isNewUser });
  } catch (err) {
    console.error(`[auth] verify-otp failed for ${email}:`, err.message);
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
