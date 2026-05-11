const { Router } = require('express');
const { getCommandCenterSnapshot } = require('../services/adminCommandCenter');

const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    res.json({
      success: true,
      data: await getCommandCenterSnapshot(),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
