const { Router } = require('express');
const multer = require('multer');
const { authenticate } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { MAX_ATTACHMENT_BYTES, isAllowedSupportAttachment } = require('../services/supportAttachments');
const { ACTORS, optionsForActor } = require('../services/supportIntake');
const {
  uploadAttachment,
  createIntakeTicket,
  createManualTicket,
  listTickets,
  getTicket,
  replyToTicket,
} = require('../services/supportCore');

const router = Router();
router.use(authenticate);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES },
  fileFilter: (_req, file, cb) => {
    if (isAllowedSupportAttachment(file)) cb(null, true);
    else cb(new AppError('Support attachments must be images or PDFs', 400), false);
  },
});

function parseAttachmentUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(new AppError('Attachment must be 5MB or smaller', 400));
    return next(err);
  });
}

const actor = {
  actorType: 'CUSTOMER',
  getActorId: (req) => req.user.userId,
  ownerField: 'userId',
  uploadPrefix: 'customer',
  bookingOwnerField: 'userId',
};

router.get('/intake/options', async (_req, res) => {
  res.json({ success: true, data: optionsForActor(ACTORS.CUSTOMER) });
});

router.post('/attachments', parseAttachmentUpload, async (req, res, next) => {
  try {
    const result = await uploadAttachment(req, next, actor);
    if (result) res.status(201).json(result);
  } catch (err) { next(err); }
});

router.post('/intake/tickets', async (req, res, next) => {
  try {
    const result = await createIntakeTicket(req, next, actor);
    if (result) res.status(201).json(result);
  } catch (err) { next(err); }
});

router.post('/tickets', async (req, res, next) => {
  try {
    const result = await createManualTicket(req, next, actor);
    if (result) res.status(201).json(result);
  } catch (err) { next(err); }
});

router.get('/tickets', async (req, res, next) => {
  try {
    const result = await listTickets(req, next, actor);
    if (result) res.json(result);
  } catch (err) { next(err); }
});

router.get('/tickets/:id', async (req, res, next) => {
  try {
    const result = await getTicket(req, next, actor);
    if (result) res.json(result);
  } catch (err) { next(err); }
});

router.post('/tickets/:id/reply', async (req, res, next) => {
  try {
    const result = await replyToTicket(req, next, actor);
    if (result) res.status(201).json(result);
  } catch (err) { next(err); }
});

module.exports = router;
