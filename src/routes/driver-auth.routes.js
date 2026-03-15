const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticateDriver } = require('../middleware/driverAuth');
const { AppError } = require('../middleware/errorHandler');

const router = Router();

// POST /api/driver/auth/sync — Create or find Driver by email from Supabase JWT
router.post('/sync', authenticateDriver, async (req, res, next) => {
  try {
    const email = req.driverEmail;
    console.log('[driver-auth] POST sync — email:', email);
    let driver = await prisma.driver.findUnique({
      where: { email },
      include: { documents: true, vehicle: true },
    });
    const isNewDriver = !driver;

    if (!driver) {
      driver = await prisma.driver.create({
        data: { email, name: '' },
        include: { documents: true, vehicle: true },
      });
      // Create wallet for new driver
      await prisma.driverWallet.create({ data: { driverId: driver.id } });
      console.log('[driver-auth] sync — created new driver id:', driver.id, 'email:', email);
    } else {
      console.log('[driver-auth] sync — found existing driver id:', driver.id, 'email:', email);
    }

    res.json({ success: true, driver, isNewDriver });
  } catch (err) {
    next(err);
  }
});

// POST /api/driver/auth/register — Full registration with details
router.post('/register', authenticateDriver, async (req, res, next) => {
  try {
    const email = req.driverEmail;
    const { name, phone, emergencyContact } = req.body;
    console.log('[driver-auth] POST register — email:', email, 'name:', name, 'phone:', phone);

    if (!name) return next(new AppError('Name is required', 400));

    let driver = await prisma.driver.findUnique({ where: { email } });

    if (!driver) {
      driver = await prisma.driver.create({
        data: { email, name, phone: phone || '', emergencyContact: emergencyContact || '' },
      });
      await prisma.driverWallet.create({ data: { driverId: driver.id } });
    } else {
      driver = await prisma.driver.update({
        where: { email },
        data: {
          name,
          ...(phone && { phone }),
          ...(emergencyContact && { emergencyContact }),
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
    next(err);
  }
});

module.exports = router;
