const { Router } = require('express');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');

const router = Router();

const apiKey = process.env.RESEND_API_KEY;
if (!apiKey) {
  console.warn('[auth] RESEND_API_KEY is not set — emails will fail');
} else {
  console.log('[auth] Resend API key loaded:', apiKey.slice(0, 6) + '...');
}
const resend = new Resend(apiKey);

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// POST /api/auth/send-otp
router.post('/send-otp', async (req, res, next) => {
  const { email, mode = 'login' } = req.body;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return next(new AppError('A valid email address is required.', 400));
  }

  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

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

    await prisma.otp.upsert({
      where: { email },
      update: { code: otp, expiresAt },
      create: { email, code: otp, expiresAt },
    });
    console.log(`[auth] OTP stored in DB for ${email}`);

    await resend.emails.send({
      from: 'CarryOn <onboarding@resend.dev>',
      to: email,
      subject: 'Your CarryOn verification code',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
          <h2 style="color: #2F80ED; margin-bottom: 4px;">CarryOn</h2>
          <p style="color: #333; font-size: 16px; margin-top: 0;">Your verification code is:</p>
          <div style="background: #f0f6ff; border-radius: 12px; padding: 24px; text-align: center; margin: 16px 0;">
            <span style="font-size: 40px; font-weight: bold; letter-spacing: 12px; color: #2F80ED;">${otp}</span>
          </div>
          <p style="color: #666; font-size: 14px;">
            This code expires in <strong>10 minutes</strong>.<br/>
            Do not share it with anyone.
          </p>
        </div>
      `,
    });

    console.log(`[auth] OTP email sent to ${email}`);
    res.json({ success: true, message: 'OTP sent successfully.' });
  } catch (err) {
    console.error(`[auth] send-otp failed for ${email}:`, err.message);
    next(err);
  }
});

// POST /api/auth/verify-otp
router.post('/verify-otp', async (req, res, next) => {
  const { email, otp, mode = 'login', name = '' } = req.body;

  if (!email || !otp) {
    return next(new AppError('Email and OTP are required.', 400));
  }

  try {
    console.log(`[auth] verify-otp request for ${email} (mode=${mode})`);
    const stored = await prisma.otp.findUnique({ where: { email } });

    if (!stored) {
      return next(new AppError('No code found for this email. Please request a new one.', 400));
    }

    if (new Date() > stored.expiresAt) {
      await prisma.otp.delete({ where: { email } });
      return next(new AppError('Code has expired. Please request a new one.', 400));
    }

    if (stored.code !== otp) {
      return next(new AppError('Incorrect code. Please try again.', 400));
    }

    await prisma.otp.delete({ where: { email } });

    let user;
    let isNewUser;

    if (mode === 'signup') {
      // Signup: create new user (upsert with name)
      const existing = await prisma.user.findUnique({ where: { email } });
      isNewUser = !existing;
      user = await prisma.user.upsert({
        where: { email },
        update: { isVerified: true, ...(name ? { name } : {}) },
        create: { email, name, isVerified: true },
      });
    } else {
      // Login: find existing user only
      user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        return next(new AppError('No account found with this email. Please sign up.', 400));
      }
      isNewUser = false;
      await prisma.user.update({ where: { email }, data: { isVerified: true } });
      user = await prisma.user.findUnique({ where: { email } });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log(`[auth] OTP verified for ${email} (mode=${mode})`);
    res.json({ success: true, message: 'OTP verified successfully.', token, user, isNewUser });
  } catch (err) {
    console.error(`[auth] verify-otp failed for ${email}:`, err.message);
    next(err);
  }
});

module.exports = router;
