const rateLimit = require('express-rate-limit');
const { Router } = require('express');
const {
  assertBookingIdShape,
  getDispatchMapSnapshot,
  getIncidentMapSnapshot,
  getLiveDashboardSnapshot,
  getLiveOverviewSnapshot,
  getOptimizeQueueSnapshot,
  runOptimize,
} = require('../services/adminMaps');

const router = Router();

const optimizeRunLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  message: { success: false, message: 'Too many optimization requests. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.get('/live-overview', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await getLiveOverviewSnapshot() });
  } catch (err) {
    next(err);
  }
});

router.get('/live-dashboard', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await getLiveDashboardSnapshot() });
  } catch (err) {
    next(err);
  }
});

router.get('/incidents', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await getIncidentMapSnapshot() });
  } catch (err) {
    next(err);
  }
});

router.get('/dispatch/:bookingId', async (req, res, next) => {
  try {
    const bookingId = req.params.bookingId;
    if (!assertBookingIdShape(bookingId)) {
      return res.status(400).json({ success: false, message: 'Invalid bookingId' });
    }

    const snapshot = await getDispatchMapSnapshot(bookingId);
    if (!snapshot) {
      return res.status(404).json({ success: false, message: 'Dispatch not found' });
    }
    res.json({ success: true, data: snapshot });
  } catch (err) {
    next(err);
  }
});

router.get('/optimize/queue', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await getOptimizeQueueSnapshot() });
  } catch (err) {
    next(err);
  }
});

router.post('/optimize/run', optimizeRunLimiter, async (req, res, next) => {
  try {
    if (!req.adminActor?.actorId) {
      return res.status(401).json({ success: false, message: 'Admin actor identity is required' });
    }

    res.json({
      success: true,
      data: await runOptimize({ actor: req.adminActor }),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
