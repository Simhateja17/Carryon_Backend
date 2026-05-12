const { Router } = require('express');
const {
  getIncidentMapSnapshot,
  getLiveDashboardSnapshot,
  getLiveOverviewSnapshot,
} = require('../services/adminMaps');

const router = Router();

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

module.exports = router;
