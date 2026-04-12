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
    const { name, phone, photo, emergencyContact, driversLicenseNumber, dateOfBirth } = req.body;
    const driver = await prisma.driver.update({
      where: { id: req.driver.id },
      data: {
        ...(name && { name }),
        ...(phone && { phone }),
        ...(photo && { photo }),
        ...(emergencyContact && { emergencyContact }),
        ...(driversLicenseNumber && { driversLicenseNumber }),
        ...(dateOfBirth && { dateOfBirth }),
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
    console.log('[driver-profile] POST toggle-online — driverId:', req.driver.id, 'isOnline →', isOnline);
    const driver = await prisma.driver.update({
      where: { id: req.driver.id },
      data: { isOnline },
    });
    console.log('[driver-profile] toggle-online — driverId:', req.driver.id, 'isOnline now:', driver.isOnline);
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
    console.log('[driver-profile] POST location — driverId:', req.driver.id, 'lat:', latitude, 'lng:', longitude);
    await prisma.driver.update({
      where: { id: req.driver.id },
      data: { currentLatitude: latitude, currentLongitude: longitude },
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// PUT /api/driver/profile/fcm-token — register or clear FCM push token
router.put('/fcm-token', async (req, res, next) => {
  try {
    const hasFcmTokenField = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'fcmToken');
    if (!hasFcmTokenField) {
      return next(new AppError('fcmToken field is required', 400));
    }

    const rawToken = req.body.fcmToken;
    if (rawToken !== null && typeof rawToken !== 'string') {
      return next(new AppError('fcmToken must be a string or null', 400));
    }

    const normalizedToken = typeof rawToken === 'string' ? rawToken.trim() : null;
    const shouldClear = normalizedToken == null || normalizedToken.length === 0;
    if (shouldClear) {
      console.log('[driver-profile] PUT fcm-token — clearing token for driverId:', req.driver.id);
    } else {
      console.log('[driver-profile] PUT fcm-token — driverId:', req.driver.id, 'token:', normalizedToken.slice(0, 10) + '...');
    }

    await prisma.driver.update({
      where: { id: req.driver.id },
      data: { fcmToken: shouldClear ? null : normalizedToken },
    });

    res.json({ success: true, data: { fcmTokenRegistered: !shouldClear } });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/driver/profile/fcm-token — explicitly clear FCM push token
router.delete('/fcm-token', async (req, res, next) => {
  try {
    await prisma.driver.update({
      where: { id: req.driver.id },
      data: { fcmToken: null },
    });
    console.log('[driver-profile] DELETE fcm-token — cleared for driverId:', req.driver.id);
    res.json({ success: true, data: { fcmTokenRegistered: false } });
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
