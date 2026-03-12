const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticateDriver, requireDriver } = require('../middleware/driverAuth');
const { AppError } = require('../middleware/errorHandler');

const router = Router();
router.use(authenticateDriver, requireDriver);

// GET /api/driver/profile
router.get('/', async (req, res, next) => {
  try {
    const driver = await prisma.driver.findUnique({
      where: { id: req.driver.id },
      include: { documents: true, vehicle: true },
    });
    res.json({ success: true, data: driver });
  } catch (err) {
    next(err);
  }
});

// PUT /api/driver/profile
router.put('/', async (req, res, next) => {
  try {
    const { name, phone, photo, emergencyContact } = req.body;
    const driver = await prisma.driver.update({
      where: { id: req.driver.id },
      data: {
        ...(name && { name }),
        ...(phone && { phone }),
        ...(photo && { photo }),
        ...(emergencyContact && { emergencyContact }),
      },
      include: { documents: true, vehicle: true },
    });
    res.json({ success: true, data: driver });
  } catch (err) {
    next(err);
  }
});

// POST /api/driver/profile/toggle-online
router.post('/toggle-online', async (req, res, next) => {
  try {
    const { isOnline } = req.body;
    if (typeof isOnline !== 'boolean') {
      return next(new AppError('isOnline must be a boolean', 400));
    }
    const driver = await prisma.driver.update({
      where: { id: req.driver.id },
      data: { isOnline },
    });
    res.json({ success: true, data: { isOnline: driver.isOnline } });
  } catch (err) {
    next(err);
  }
});

// POST /api/driver/profile/location
router.post('/location', async (req, res, next) => {
  try {
    const { latitude, longitude } = req.body;
    if (latitude == null || longitude == null) {
      return next(new AppError('latitude and longitude are required', 400));
    }
    await prisma.driver.update({
      where: { id: req.driver.id },
      data: { currentLatitude: latitude, currentLongitude: longitude },
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// PUT /api/driver/profile/fcm-token — register FCM push token
router.put('/fcm-token', async (req, res, next) => {
  try {
    const { fcmToken } = req.body;
    if (!fcmToken) {
      return next(new AppError('fcmToken is required', 400));
    }
    await prisma.driver.update({
      where: { id: req.driver.id },
      data: { fcmToken },
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/driver/profile/verification-status
router.get('/verification-status', async (req, res, next) => {
  try {
    const driver = await prisma.driver.findUnique({
      where: { id: req.driver.id },
      include: { documents: true },
    });
    res.json({
      success: true,
      data: {
        verificationStatus: driver.verificationStatus,
        isVerified: driver.isVerified,
        documents: driver.documents,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
