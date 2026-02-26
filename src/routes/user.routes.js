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
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { id: true, profileImage: true, language: true, isVerified: true, referralCode: true, createdAt: true, updatedAt: true },
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

// PUT /api/users/me
router.put('/me', async (req, res, next) => {
  try {
    const { name, phone, profileImage, language } = req.body;
    const user = await prisma.user.update({
      where: { id: req.user.userId },
      data: {
        ...(name !== undefined && { name }),
        ...(phone !== undefined && { phone }),
        ...(profileImage !== undefined && { profileImage }),
        ...(language !== undefined && { language }),
      },
    });
    res.json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
