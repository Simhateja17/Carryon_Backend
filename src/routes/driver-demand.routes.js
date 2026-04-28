const { Router } = require('express');
const { authenticateDriver, requireDriver } = require('../middleware/driverAuth');
const { AppError } = require('../middleware/errorHandler');
const { computeDemandZones } = require('../services/demandZones');

const router = Router();
router.use(authenticateDriver, requireDriver);

router.get('/demand-zones', async (req, res, next) => {
  try {
    const result = await computeDemandZones({
      lat: req.query.lat,
      lng: req.query.lng,
      radiusKm: req.query.radiusKm,
      vehicleType: req.driver?.vehicle?.type,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    if (err.statusCode) return next(new AppError(err.message, err.statusCode));
    next(err);
  }
});

module.exports = router;
