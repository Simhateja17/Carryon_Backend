const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticateDriver, requireDriver } = require('../middleware/driverAuth');

const router = Router();
router.use(authenticateDriver, requireDriver);

// GET /api/driver/notifications
router.get('/', async (req, res, next) => {
  try {
    const notifications = await prisma.driverNotification.findMany({
      where: { driverId: req.driver.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json({ success: true, data: notifications });
  } catch (err) {
    next(err);
  }
});

// PUT /api/driver/notifications/:id/read
router.put('/:id/read', async (req, res, next) => {
  try {
    const notification = await prisma.driverNotification.findUnique({
      where: { id: req.params.id },
    });
    if (!notification || notification.driverId !== req.driver.id) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }

    await prisma.driverNotification.update({
      where: { id: req.params.id },
      data: { isRead: true },
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
