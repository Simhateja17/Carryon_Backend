const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticate } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');

const router = Router();
router.use(authenticate);

// GET /api/users/me
router.get('/me', async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
    });
    if (!user) return next(new AppError('User not found', 404));
    res.json({ success: true, data: user });
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
