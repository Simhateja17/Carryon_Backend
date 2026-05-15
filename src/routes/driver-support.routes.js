const { Router } = require('express');
const multer = require('multer');
const prisma = require('../lib/prisma');
const { authenticateDriver, requireDriver } = require('../middleware/driverAuth');
const { AppError } = require('../middleware/errorHandler');
const { uploadToSupabase } = require('../lib/supabase');
const {
  MAX_ATTACHMENT_BYTES,
  attachmentCreateMany,
  isAllowedSupportAttachment,
  validateAttachments,
} = require('../services/supportAttachments');
const {
  ACTORS,
  findIssue,
  findPath,
  makeSubject,
  optionsForActor,
  summarizeIntake,
} = require('../services/supportIntake');

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

router.get('/intake/options', async (req, res) => {
  res.json({ success: true, data: optionsForActor(ACTORS.DRIVER) });
});

router.post('/attachments', parseAttachmentUpload, async (req, res, next) => {
  try {
    if (!req.file) return next(new AppError('No attachment file provided', 400));
    const ext = req.file.originalname.split('.').pop() || 'bin';
    const path = `driver/${req.driver.id}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const fileUrl = await uploadToSupabase('support-attachments', req.file, path);
    res.status(201).json({
      success: true,
      data: {
        fileUrl,
        storagePath: fileUrl,
        mimeType: req.file.mimetype,
        fileSize: req.file.size,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/driver/support/articles
router.get('/articles', async (req, res, next) => {
  try {
    let articles = await prisma.helpArticle.findMany({
      orderBy: { createdAt: 'asc' },
    });

    res.json({ success: true, data: articles });
  } catch (err) {
    next(err);
  }
});

// GET /api/driver/support/tickets
router.get('/tickets', async (req, res, next) => {
  try {
    const tickets = await prisma.driverSupportTicket.findMany({
      where: { driverId: req.driver.id },
      orderBy: { createdAt: 'desc' },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    res.json({ success: true, data: tickets });
  } catch (err) {
    next(err);
  }
});

// POST /api/driver/support/tickets
router.post('/tickets', async (req, res, next) => {
  try {
    const { subject, category, description, bookingId, attachments: rawAttachments } = req.body;
    console.log('[driver-support] POST ticket — driverId:', req.driver.id, 'subject:', subject, 'category:', category || 'GENERAL');
    if (!subject) return next(new AppError('Subject is required', 400));

    const attachmentResult = validateAttachments(rawAttachments);
    if (!attachmentResult.ok) return next(new AppError(attachmentResult.message, 400));

    if (bookingId) {
      const booking = await prisma.booking.findFirst({
        where: { id: bookingId, driverId: req.driver.id },
        select: { id: true },
      });
      if (!booking) return next(new AppError('Job not found for this driver', 404));
    }

    const ticket = await prisma.$transaction(async (tx) => {
      const created = await tx.driverSupportTicket.create({
        data: {
          driverId: req.driver.id,
          bookingId: bookingId || null,
          subject,
          category: category || 'GENERAL',
          description: description || '',
          source: 'MANUAL',
          messages: {
            create: {
              senderId: req.driver.id,
              isStaff: false,
              messageType: 'USER_MESSAGE',
              isCustomerVisible: true,
              message: description || subject,
            },
          },
        },
        include: { messages: true },
      });
      const firstMessage = created.messages[0];
      if (firstMessage && attachmentResult.attachments.length > 0) {
        await tx.driverTicketAttachment.createMany({
          data: attachmentCreateMany({
            attachments: attachmentResult.attachments,
            ticketId: created.id,
            messageId: firstMessage.id,
            uploadedById: req.driver.id,
            uploadedByType: 'DRIVER',
          }),
        });
      }
      return tx.driverSupportTicket.findUnique({
        where: { id: created.id },
        include: { messages: { orderBy: { createdAt: 'asc' }, include: { attachments: true } } },
      });
    });

    console.log('[driver-support] ticket created — ticketId:', ticket.id, 'driverId:', req.driver.id, 'subject:', subject);
    res.status(201).json({ success: true, data: ticket });
  } catch (err) {
    next(err);
  }
});

router.post('/intake/tickets', async (req, res, next) => {
  try {
    const { issueId, bookingId, details, answers, attachments: rawAttachments, displayPath } = req.body || {};
    const issue = findIssue(ACTORS.DRIVER, issueId);
    if (!issue) return next(new AppError('Unsupported support issue', 400));
    if (issue.emergency) {
      return next(new AppError('Use the SOS endpoint for emergency support', 400));
    }

    const trimmedDetails = typeof details === 'string' ? details.trim() : '';
    if (issue.requiresDetails && trimmedDetails.length < 3) {
      return next(new AppError('Issue details are required', 400));
    }

    const attachmentResult = validateAttachments(rawAttachments);
    if (!attachmentResult.ok) return next(new AppError(attachmentResult.message, 400));

    let booking = null;
    if (issue.requiresBooking || bookingId) {
      if (!bookingId) return next(new AppError('Job selection is required for this issue', 400));
      booking = await prisma.booking.findFirst({
        where: { id: bookingId, driverId: req.driver.id },
        select: { id: true, orderCode: true, status: true, vehicleType: true },
      });
      if (!booking) return next(new AppError('Job not found for this driver', 404));
    }

    const path = findPath(ACTORS.DRIVER, issue.id);
    const intakeAnswers = {
      issueId: issue.id,
      displayPath: Array.isArray(displayPath) ? displayPath : [],
      answers: answers && typeof answers === 'object' ? answers : {},
    };
    const message = summarizeIntake({
      actor: ACTORS.DRIVER,
      issue,
      path,
      booking,
      details: trimmedDetails,
      answers: intakeAnswers.answers,
    });

    const ticket = await prisma.$transaction(async (tx) => {
      const created = await tx.driverSupportTicket.create({
        data: {
          driverId: req.driver.id,
          bookingId: booking?.id || null,
          subject: makeSubject({ actor: ACTORS.DRIVER, issue, booking }),
          category: issue.category,
          priority: issue.priority,
          description: trimmedDetails,
          source: 'AUTOMATION_BOT',
          intakePath: path,
          intakeAnswers,
          messages: {
            create: {
              senderId: req.driver.id,
              isStaff: false,
              messageType: 'USER_MESSAGE',
              isCustomerVisible: true,
              message,
            },
          },
        },
        include: { messages: true },
      });
      const firstMessage = created.messages[0];
      if (firstMessage && attachmentResult.attachments.length > 0) {
        await tx.driverTicketAttachment.createMany({
          data: attachmentCreateMany({
            attachments: attachmentResult.attachments,
            ticketId: created.id,
            messageId: firstMessage.id,
            uploadedById: req.driver.id,
            uploadedByType: 'DRIVER',
          }),
        });
      }
      return tx.driverSupportTicket.findUnique({
        where: { id: created.id },
        include: {
          messages: { orderBy: { createdAt: 'asc' }, include: { attachments: true } },
          booking: { select: { id: true, orderCode: true, status: true, vehicleType: true } },
        },
      });
    });

    res.status(201).json({ success: true, data: ticket });
  } catch (err) {
    next(err);
  }
});

// GET /api/driver/support/tickets/:id
router.get('/tickets/:id', async (req, res, next) => {
  try {
    const ticket = await prisma.driverSupportTicket.findUnique({
      where: { id: req.params.id },
      include: {
        messages: {
          where: { isCustomerVisible: true },
          orderBy: { createdAt: 'asc' },
          include: { attachments: true },
        },
      },
    });
    if (!ticket) return next(new AppError('Ticket not found', 404));
    if (ticket.driverId !== req.driver.id) return next(new AppError('Not authorized', 403));

    res.json({ success: true, data: ticket });
  } catch (err) {
    next(err);
  }
});

// POST /api/driver/support/tickets/:id/reply
router.post('/tickets/:id/reply', async (req, res, next) => {
  try {
    const { message, attachments: rawAttachments } = req.body;
    if (!message && (!Array.isArray(rawAttachments) || rawAttachments.length === 0)) {
      return next(new AppError('Message or attachment is required', 400));
    }
    const attachmentResult = validateAttachments(rawAttachments);
    if (!attachmentResult.ok) return next(new AppError(attachmentResult.message, 400));

    const ticket = await prisma.driverSupportTicket.findUnique({ where: { id: req.params.id } });
    if (!ticket) return next(new AppError('Ticket not found', 404));
    if (ticket.driverId !== req.driver.id) return next(new AppError('Not authorized', 403));

    if (ticket.status === 'CLOSED') return next(new AppError('Ticket is closed', 400));

    const ticketMessage = await prisma.$transaction(async (tx) => {
      const created = await tx.driverTicketMessage.create({
        data: {
          ticketId: req.params.id,
          senderId: req.driver.id,
          isStaff: false,
          messageType: 'USER_MESSAGE',
          isCustomerVisible: true,
          message: message || '',
        },
        include: { attachments: true },
      });
      if (attachmentResult.attachments.length > 0) {
        await tx.driverTicketAttachment.createMany({
          data: attachmentCreateMany({
            attachments: attachmentResult.attachments,
            ticketId: req.params.id,
            messageId: created.id,
            uploadedById: req.driver.id,
            uploadedByType: 'DRIVER',
          }),
        });
      }
      if (ticket.status === 'RESOLVED') {
        await tx.driverSupportTicket.update({
          where: { id: req.params.id },
          data: { status: 'OPEN' },
        });
      }
      return tx.driverTicketMessage.findUnique({
        where: { id: created.id },
        include: { attachments: true },
      });
    });

    res.status(201).json({ success: true, data: ticketMessage });
  } catch (err) {
    next(err);
  }
});

// POST /api/driver/support/tickets/:id/close is intentionally unsupported.
// Customer/driver-facing ticket closure is staff-owned in the admin support flow.

// POST /api/driver/support/sos — emergency
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

    // Create urgent notification
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
  } catch (err) {
    next(err);
  }
});

module.exports = router;
