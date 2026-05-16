const { Router } = require('express');
const multer = require('multer');
const prisma = require('../lib/prisma');
const { authenticateDriver, requireDriver } = require('../middleware/driverAuth');
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
router.use(authenticateDriver, requireDriver);

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
  actorType: 'DRIVER',
  getActorId: (req) => req.driver.id,
  ownerField: 'driverId',
  uploadPrefix: 'driver',
  bookingOwnerField: 'driverId',
};

router.get('/intake/options', async (_req, res) => {
  res.json({ success: true, data: optionsForActor(ACTORS.DRIVER) });
});

router.post('/attachments', parseAttachmentUpload, async (req, res, next) => {
  try {
    const result = await uploadAttachment(req, next, actor);
    if (result) res.status(201).json(result);
  } catch (err) { next(err); }
});

// Driver-only: help articles
router.get('/articles', async (_req, res, next) => {
  try {
    const articles = await prisma.helpArticle.findMany({ orderBy: { createdAt: 'asc' } });
    res.json({ success: true, data: articles });
  } catch (err) { next(err); }
});

router.get('/tickets', async (req, res, next) => {
  try {
    const result = await listTickets(req, next, actor);
    if (result) res.json(result);
  } catch (err) { next(err); }
});

router.post('/tickets', async (req, res, next) => {
  try {
    const result = await createManualTicket(req, next, actor);
    if (result) res.status(201).json(result);
  } catch (err) { next(err); }
});

router.post('/intake/tickets', async (req, res, next) => {
  try {
    const result = await createIntakeTicket(req, next, actor);
    if (result) res.status(201).json(result);
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

// Driver-only: SOS emergency
router.post('/sos', async (req, res, next) => {
  try {
    const { latitude, longitude, accuracyMeters, capturedAt } = req.body;
    console.log('[driver-support] POST SOS — driverId:', req.driver.id, 'location:', latitude, longitude);

    const ticket = await prisma.driverSupportTicket.create({
      data: {
        driverId: req.driver.id,
        subject: 'SOS Emergency',
        category: 'GENERAL',
        description: `Emergency SOS triggered. Dial 999 immediately. Location: ${latitude}, ${longitude}. Accuracy: ${accuracyMeters || 'unknown'}m. Captured at: ${capturedAt || new Date().toISOString()}`,
        priority: 'URGENT',
        messages: {
          create: {
            senderId: req.driver.id,
            message: `SOS Emergency. Driver should call 999. Location snapshot: ${latitude}, ${longitude}`,
          },
        },
      },
    });

    await prisma.driverNotification.create({
      data: {
        driverId: req.driver.id,
        title: 'SOS Received',
        message: 'Your emergency alert has been received. Help is on the way.',
        type: 'ALERT',
      },
    });
    console.log('[driver-support] SOS ticket created — ticketId:', ticket.id, 'driverId:', req.driver.id, 'location:', latitude, longitude);

    res.status(201).json({
      success: true,
      data: {
        ticket,
        emergencyNumber: '999',
        action: 'CALL_EMERGENCY_SERVICES',
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
