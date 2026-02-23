const { Router } = require('express');
const prisma = require('../lib/prisma');

const router = Router();

// GET /api/vehicles
router.get('/', async (req, res, next) => {
  try {
    const vehicles = await prisma.vehicle.findMany({
      where: { isAvailable: true },
      orderBy: { basePrice: 'asc' },
    });
    res.json({ success: true, data: vehicles });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
