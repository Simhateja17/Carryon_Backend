const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticateDriver } = require('../middleware/driverAuth');
const { AppError } = require('../middleware/errorHandler');
const { maskEmail } = require('../lib/maskEmail');
const { normalizeLanguageCode } = require('../lib/supportedLanguages');

const router = Router();

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
      console.log('[driver-auth] sync — created new driver id:', driver.id, 'email:', email);
    } else {
      if (language !== undefined && driver.language !== language) {
        driver = await prisma.driver.update({
          where: { id: driver.id },
          data: { language },
          include: { documents: true, vehicle: true },
        });
      }
      console.log('[driver-auth] sync — found existing driver id:', driver.id, 'email:', email);
    }

    res.json({ success: true, driver, isNewDriver });
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
    console.log('[driver-auth] POST register — email:', maskEmail(email), 'name:', name, 'phone:', phone);

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

    res.json({ success: true, driver });
  } catch (err) {
    console.error('[driver-auth] register failed: unexpected error', {
      message: err.message,
      stack: err.stack,
    });
    next(err);
  }
});

module.exports = router;
