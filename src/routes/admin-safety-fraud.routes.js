const { Router } = require('express');
const { getSafetyFraudSnapshot } = require('../services/adminSafetyFraud');

const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await getSafetyFraudSnapshot() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
