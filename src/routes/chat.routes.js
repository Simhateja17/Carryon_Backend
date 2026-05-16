const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { getMessages, sendMessage, getQuickMessages } = require('../services/chatCore');

const router = Router();
router.use(authenticate);

const actor = {
  getActorId: (req) => req.user.userId,
  senderType: 'USER',
  opponentType: 'DRIVER',
  bookingOwnerField: 'userId',
  logPrefix: 'chat',
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
