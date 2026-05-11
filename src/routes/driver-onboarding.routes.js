const { Router } = require('express');
const { authenticateDriver, requireDriver } = require('../middleware/driverAuth');
const { submitDriverOnboarding } = require('../services/driverOnboarding');
const { serializeDriver } = require('../lib/driverResponse');

const router = Router();
router.use(authenticateDriver, requireDriver);

// PUT /api/driver/onboarding — final 13-step onboarding submission
router.put('/', async (req, res, next) => {
  try {
    const driver = await submitDriverOnboarding(req.driver.id, req.body, {
      actor: { actorId: req.driver.id, actorType: 'DRIVER' },
    });
    res.json({ success: true, data: serializeDriver(driver) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
