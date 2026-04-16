const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticate } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');

const router = Router();
router.use(authenticate);

// GET /api/users/me
// User identity fields (userId, email, name, phone) are embedded in the JWT —
// no DB query needed here. Profile image and language still require a DB fetch
// since they are not in the token.
router.get('/me', async (req, res, next) => {
  try {
    console.log('[user] GET /me — userId:', req.user.userId);
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { id: true, profileImage: true, language: true, isVerified: true, referralCode: true, createdAt: true },
    });
    if (!user) return next(new AppError('User not found', 404));
    res.json({
      success: true,
      data: {
        ...user,
        email: req.user.email,
        name: req.user.name,
        phone: req.user.phone,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/users/me/stats
router.get('/me/stats', async (req, res, next) => {
  try {
    const userId = req.user.userId;
    console.log('[user] GET /me/stats — userId:', userId);

    const [bookingCount, ratingResult] = await Promise.all([
      prisma.booking.count({ where: { userId } }),
      prisma.order.aggregate({
        where: { booking: { userId }, rating: { not: null } },
        _avg: { rating: true },
        _count: { rating: true },
      }),
    ]);

    res.json({
      success: true,
      data: {
        totalShipments: bookingCount,
        userRating: ratingResult._avg.rating || 0,
        ratingCount: ratingResult._count.rating || 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/me
router.put('/me', async (req, res, next) => {
  try {
    const { name, phone, profileImage, language } = req.body;
    console.log('[user] PUT /me — userId:', req.user.userId);
    const user = await prisma.user.update({
      where: { id: req.user.userId },
      data: {
        ...(name !== undefined && { name }),
        ...(phone !== undefined && { phone }),
        ...(profileImage !== undefined && { profileImage }),
        ...(language !== undefined && { language }),
      },
    });
    console.log('[user] PUT /me — updated userId:', user.id);
    res.json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
