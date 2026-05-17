const { Router } = require('express');
const { AppError } = require('../middleware/errorHandler');
const { getAnalyticsSnapshot } = require('../services/adminAnalytics');

const router = Router();
const VALID_PERIODS = new Set(['today', 'weekly', 'monthly']);

router.get('/', async (req, res, next) => {
  try {
    const period = String(req.query.period || 'today').toLowerCase();
    if (!VALID_PERIODS.has(period)) {
      return next(new AppError('Invalid period. Must be today, weekly, or monthly', 400));
    }

    res.json({
      success: true,
      data: await getAnalyticsSnapshot({ period }),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
