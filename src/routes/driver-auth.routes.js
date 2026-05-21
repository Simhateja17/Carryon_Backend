const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticateDriver } = require('../middleware/driverAuth');
const { AppError } = require('../middleware/errorHandler');
const { maskEmail } = require('../lib/maskEmail');
const { normalizeLanguageCode } = require('../lib/supportedLanguages');
const { serializeDriver } = require('../lib/driverResponse');
const { OTP_LENGTH, isValidOtp, normalizeOtp } = require('../lib/otp');
const {
  normalizeEmail,
  normalizePhone,
  maskPhone,
  resolveUniqueByPhone,
  assertUniquePhone,
  sendSmsOtp,
  verifySmsOtp,
} = require('../services/authOtp');

const router = Router();

function phoneOnlyEmail(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return '';
  return `driver-phone-${normalized.slice(1)}@phone.carryon.local`;
}

// POST /api/driver/auth/send-otp — Send driver login/signup OTP by SMS
router.post('/send-otp', async (req, res, next) => {
  let email = normalizeEmail(req.body.email);
  const mode = req.body.mode || 'login';
  const requestedPhone = normalizePhone(req.body.phone);

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('[driver-auth] send-otp failed: invalid email payload', {
      rawEmail: req.body.email,
      normalizedEmail: email,
    });
    return next(new AppError('A valid email address is required.', 400));
  }

  try {
    let phone = requestedPhone;
    if (mode === 'login') {
      const driver = email
        ? await prisma.driver.findUnique({ where: { email } })
        : await resolveUniqueByPhone({ prisma, model: 'driver', phone });
      if (!driver) {
        return next(new AppError('No driver account found with this phone number. Please sign up.', 400));
      }
      email = driver.email;
      phone = normalizePhone(driver.phone);
      if (!phone) {
        return next(new AppError('This driver account does not have a valid phone number. Please contact support.', 400));
      }
    } else if (mode === 'signup') {
      if (!phone) {
        return next(new AppError('A valid phone number is required.', 400));
      }
      if (!email) email = phoneOnlyEmail(phone);
      const existingDriver = await prisma.driver.findUnique({ where: { email } });
      if (existingDriver) {
        return next(new AppError('A driver account with this phone number already exists. Please log in.', 400));
      }
      await assertUniquePhone({ prisma, model: 'driver', phone });
    } else {
      return next(new AppError('Invalid OTP mode.', 400));
    }

    const sent = await sendSmsOtp(phone);
    console.log(`[driver-auth] OTP sent to ${maskEmail(email)} via SMS ${sent.maskedPhone}`);
    res.json({ success: true, message: 'OTP sent successfully.', maskedPhone: sent.maskedPhone });
  } catch (err) {
    console.error('[driver-auth] send-otp failed', {
      email: maskEmail(email),
      mode,
      message: err.message,
    });
    next(err);
  }
});

// POST /api/driver/auth/verify-otp — Verify driver SMS OTP and sync/register Driver
router.post('/verify-otp', async (req, res, next) => {
  let email = normalizeEmail(req.body.email);
  const mode = req.body.mode || 'login';
  const requestedPhone = normalizePhone(req.body.phone);
  const { otp, name = '', emergencyContact = '' } = req.body;
  const requestedLanguage = req.body?.language ?? req.body?.preferredLanguage;
  const language = requestedLanguage !== undefined ? normalizeLanguageCode(requestedLanguage) : undefined;

  if (!otp) {
    return next(new AppError('Phone number and OTP are required.', 400));
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return next(new AppError('A valid email address is required.', 400));
  }
  if (!isValidOtp(otp)) {
    return next(new AppError(`OTP must be ${OTP_LENGTH} digits.`, 400));
  }

  try {
    let phone = requestedPhone;
    if (mode === 'login') {
      const existingDriver = email
        ? await prisma.driver.findUnique({ where: { email } })
        : await resolveUniqueByPhone({ prisma, model: 'driver', phone });
      if (!existingDriver) {
        return next(new AppError('No driver account found with this phone number. Please sign up.', 400));
      }
      email = existingDriver.email;
      phone = normalizePhone(existingDriver.phone);
    } else if (mode === 'signup') {
      if (!phone) {
        return next(new AppError('A valid phone number is required.', 400));
      }
      if (!email) email = phoneOnlyEmail(phone);
      await assertUniquePhone({ prisma, model: 'driver', phone, excludingEmail: email });
    } else {
      return next(new AppError('Invalid OTP mode.', 400));
    }

    const { token, refreshToken, expiresIn } = await verifySmsOtp({ phone, otp: normalizeOtp(otp) });

    let driver = await prisma.driver.findUnique({
      where: { email },
      include: { documents: true, vehicle: true },
    });
    const isNewDriver = !driver;
    if (isNewDriver) {
      await assertUniquePhone({ prisma, model: 'driver', phone, excludingEmail: email });
    }

    if (!driver) {
      driver = await prisma.driver.create({
        data: {
          email,
          name,
          phone,
          emergencyContact,
          ...(language !== undefined && { language }),
        },
        include: { documents: true, vehicle: true },
      });
      await prisma.driverWallet.create({ data: { driverId: driver.id } });
    } else {
      driver = await prisma.driver.update({
        where: { email },
        data: {
          ...(name ? { name } : {}),
          ...(phone ? { phone } : {}),
          ...(emergencyContact ? { emergencyContact } : {}),
          ...(language !== undefined && { language }),
        },
        include: { documents: true, vehicle: true },
      });
    }

    console.log(`[driver-auth] OTP verified for ${maskEmail(email)} via SMS ${maskPhone(phone)} (mode=${mode})`);
    res.json({
      success: true,
      driver: serializeDriver(driver),
      isNewDriver,
      token,
      refreshToken,
      expiresIn,
    });
  } catch (err) {
    console.error('[driver-auth] verify-otp failed', {
      email: maskEmail(email),
      mode,
      message: err.message,
    });
    next(err);
  }
});

// POST /api/driver/auth/sync — Create or find Driver by email from Supabase JWT
router.post('/sync', authenticateDriver, async (req, res, next) => {
  try {
    const email = req.driverEmail;
    if (!email) {
      console.error('[driver-auth] sync failed: authenticated token has no email', {
        path: req.originalUrl,
        method: req.method,
      });
      return next(new AppError('Unable to identify driver email from token', 401));
    }
    console.log('[driver-auth] POST sync — email:', maskEmail(email));
    const requestedLanguage = req.body?.language;
    const language = requestedLanguage !== undefined ? normalizeLanguageCode(requestedLanguage) : undefined;
    let driver = await prisma.driver.findUnique({
      where: { email },
      include: { documents: true, vehicle: true },
    });
    const isNewDriver = !driver;

    if (!driver) {
      driver = await prisma.driver.create({
        data: { email, name: '', ...(language !== undefined && { language }) },
        include: { documents: true, vehicle: true },
      });
      // Create wallet for new driver
      await prisma.driverWallet.create({ data: { driverId: driver.id } });
      console.log('[driver-auth] sync — created new driver id:', driver.id);
    } else {
      if (language !== undefined && driver.language !== language) {
        driver = await prisma.driver.update({
          where: { id: driver.id },
          data: { language },
          include: { documents: true, vehicle: true },
        });
      }
      console.log('[driver-auth] sync — found existing driver id:', driver.id);
    }

    res.json({ success: true, driver: serializeDriver(driver), isNewDriver });
  } catch (err) {
    console.error('[driver-auth] sync failed: unexpected error', {
      message: err.message,
      stack: err.stack,
    });
    next(err);
  }
});

// POST /api/driver/auth/register — Full registration with details
router.post('/register', authenticateDriver, async (req, res, next) => {
  try {
    const email = req.driverEmail;
    const { name, phone, emergencyContact } = req.body;
    const requestedLanguage = req.body?.language ?? req.body?.preferredLanguage;
    const language = requestedLanguage !== undefined ? normalizeLanguageCode(requestedLanguage) : undefined;
    if (!email) {
      console.error('[driver-auth] register failed: authenticated token has no email', {
        path: req.originalUrl,
        method: req.method,
      });
      return next(new AppError('Unable to identify driver email from token', 401));
    }
    console.log('[driver-auth] POST register — email:', maskEmail(email));

    if (!name) {
      console.error('[driver-auth] register failed: missing required name', {
        email: maskEmail(email),
        hasPhone: !!phone,
        hasEmergencyContact: !!emergencyContact,
      });
      return next(new AppError('Name is required', 400));
    }

    let driver = await prisma.driver.findUnique({ where: { email } });

    if (!driver) {
      driver = await prisma.driver.create({
        data: {
          email,
          name,
          phone: phone || '',
          emergencyContact: emergencyContact || '',
          ...(language !== undefined && { language }),
        },
      });
      await prisma.driverWallet.create({ data: { driverId: driver.id } });
    } else {
      driver = await prisma.driver.update({
        where: { email },
        data: {
          name,
          ...(phone && { phone }),
          ...(emergencyContact && { emergencyContact }),
          ...(language !== undefined && { language }),
        },
      });
    }

    driver = await prisma.driver.findUnique({
      where: { email },
      include: { documents: true, vehicle: true },
    });
    console.log('[driver-auth] register — driverId:', driver.id, 'name:', driver.name, 'phone:', driver.phone);

    res.json({ success: true, driver: serializeDriver(driver) });
  } catch (err) {
    console.error('[driver-auth] register failed: unexpected error', {
      message: err.message,
      stack: err.stack,
    });
    next(err);
  }
});

module.exports = router;
