const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticateDriver, requireDriver } = require('../middleware/driverAuth');
const { AppError } = require('../middleware/errorHandler');
const { VALID_VEHICLE_TYPES } = require('../services/businessConfig');

const router = Router();
router.use(authenticateDriver, requireDriver);

// POST /api/driver/vehicle — create or update vehicle
router.post('/', async (req, res, next) => {
  try {
    const { type, make, model, year, licensePlate, color } = req.body;
    console.log('[driver-vehicle] POST upsert — driverId:', req.driver.id, 'type:', type, 'licensePlate:', licensePlate);
    if (type && !VALID_VEHICLE_TYPES.includes(type)) {
      return next(new AppError(`Invalid type. Must be one of: ${VALID_VEHICLE_TYPES.join(', ')}`, 400));
    }

    const vehicle = await prisma.driverVehicle.upsert({
      where: { driverId: req.driver.id },
      update: {
        ...(type && { type }),
        ...(make && { make }),
        ...(model && { model }),
        ...(year && { year }),
        ...(licensePlate && { licensePlate }),
        ...(color && { color }),
      },
      create: {
        driverId: req.driver.id,
        type: type || 'CAR',
        make: make || '',
        model: model || '',
        year: year || 0,
        licensePlate: licensePlate || '',
        color: color || '',
      },
    });

    // Also update legacy fields on Driver
    if (licensePlate || model) {
      await prisma.driver.update({
        where: { id: req.driver.id },
        data: {
          ...(licensePlate && { vehicleNumber: licensePlate }),
          ...(model && { vehicleModel: `${make || ''} ${model || ''}`.trim() }),
        },
      });
    }

    console.log('[driver-vehicle] upserted — driverId:', req.driver.id, 'vehicleId:', vehicle.id);
    res.json({ success: true, data: vehicle });
  } catch (err) {
    next(err);
  }
});

// GET /api/driver/vehicle
router.get('/', async (req, res, next) => {
  try {
    const vehicle = await prisma.driverVehicle.findUnique({
      where: { driverId: req.driver.id },
    });
    res.json({ success: true, data: vehicle });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
