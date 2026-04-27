const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { publicStripeConfig } = require('../lib/stripe');

const router = Router();

router.get('/config', authenticate, (req, res) => {
  res.json({
    success: true,
    data: publicStripeConfig(),
  });
});

module.exports = router;
