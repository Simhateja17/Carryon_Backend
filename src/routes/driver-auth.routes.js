const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticateDriver } = require('../middleware/driverAuth');
const { AppError } = require('../middleware/errorHandler');

const router = Router();

// POST /api/driver/auth/sync — Create or find Driver by email from Supabase JWT
router.post('/sync', authenticateDriver, async (req, res, next) => {
  try {
    const email = req.driverEmail;
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

    res.json({ success: true, driver });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
