const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticate } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');

const router = Router();
router.use(authenticate);

// GET /api/addresses
router.get('/', async (req, res, next) => {
  try {
    const addresses = await prisma.address.findMany({
      where: { userId: req.user.userId },
    });
    res.json({ success: true, data: addresses });
  } catch (err) {
    next(err);
  }
});

// POST /api/addresses
router.post('/', async (req, res, next) => {
  try {
    const { label, address, landmark, latitude, longitude, contactName, contactPhone, type } = req.body;
    const created = await prisma.address.create({
      data: {
        userId: req.user.userId,
        label: label || '',
        address: address || '',
        landmark: landmark || '',
        latitude: latitude || 0,
        longitude: longitude || 0,
        contactName: contactName || '',
        contactPhone: contactPhone || '',
        type: type || 'OTHER',
      },
    });
    res.status(201).json({ success: true, data: created });
  } catch (err) {
    next(err);
  }
});

// PUT /api/addresses/:id
router.put('/:id', async (req, res, next) => {
  try {
    const existing = await prisma.address.findUnique({ where: { id: req.params.id } });
    if (!existing) return next(new AppError('Address not found', 404));
    if (existing.userId !== req.user.userId) return next(new AppError('Not authorized', 403));

    const { label, address, landmark, latitude, longitude, contactName, contactPhone, type } = req.body;
    const updated = await prisma.address.update({
      where: { id: req.params.id },
      data: {
        ...(label !== undefined && { label }),
        ...(address !== undefined && { address }),
        ...(landmark !== undefined && { landmark }),
        ...(latitude !== undefined && { latitude }),
        ...(longitude !== undefined && { longitude }),
        ...(contactName !== undefined && { contactName }),
        ...(contactPhone !== undefined && { contactPhone }),
        ...(type !== undefined && { type }),
      },
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/addresses/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await prisma.address.findUnique({ where: { id: req.params.id } });
    if (!existing) return next(new AppError('Address not found', 404));
    if (existing.userId !== req.user.userId) return next(new AppError('Not authorized', 403));

    await prisma.address.delete({ where: { id: req.params.id } });
    res.json({ success: true, message: 'Address deleted' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
