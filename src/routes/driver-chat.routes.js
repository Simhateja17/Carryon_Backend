const { Router } = require('express');
const { authenticateDriver, requireDriver } = require('../middleware/driverAuth');
const { getMessages, sendMessage, getQuickMessages } = require('../services/chatCore');

const router = Router();
router.use(authenticateDriver, requireDriver);

const actor = {
  getActorId: (req) => req.driver.id,
  senderType: 'DRIVER',
  opponentType: 'USER',
  bookingOwnerField: 'driverId',
  logPrefix: 'driver-chat',
};

router.get('/:bookingId', async (req, res, next) => {
  try {
    const result = await getMessages(req, next, actor);
    if (result) res.json(result);
  } catch (err) { next(err); }
});

router.post('/:bookingId', async (req, res, next) => {
  try {
    const result = await sendMessage(req, next, actor);
    if (result) res.status(201).json(result);
  } catch (err) { next(err); }
});

router.get('/:bookingId/quick-messages', async (_req, res, next) => {
  try {
    res.json(getQuickMessages());
  } catch (err) { next(err); }
});

module.exports = router;
