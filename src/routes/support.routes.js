const { Router } = require('express');
const multer = require('multer');
const prisma = require('../lib/prisma');
const { authenticate } = require('../middleware/auth');
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

router.get('/intake/options', async (req, res) => {
  res.json({ success: true, data: optionsForActor(ACTORS.CUSTOMER) });
});

router.post('/attachments', parseAttachmentUpload, async (req, res, next) => {
  try {
    if (!req.file) return next(new AppError('No attachment file provided', 400));
    const ext = req.file.originalname.split('.').pop() || 'bin';
    const path = `customer/${req.user.userId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
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

// POST /api/support/intake/tickets - Create a ticket from deterministic bot intake
router.post('/intake/tickets', async (req, res, next) => {
  try {
    const { issueId, bookingId, details, answers, attachments: rawAttachments, displayPath } = req.body || {};
    const issue = findIssue(ACTORS.CUSTOMER, issueId);
    if (!issue) return next(new AppError('Unsupported support issue', 400));

    const trimmedDetails = typeof details === 'string' ? details.trim() : '';
    if (issue.requiresDetails && trimmedDetails.length < 3) {
      return next(new AppError('Issue details are required', 400));
    }

    const attachmentResult = validateAttachments(rawAttachments);
    if (!attachmentResult.ok) return next(new AppError(attachmentResult.message, 400));

    let booking = null;
    if (issue.requiresBooking || bookingId) {
      if (!bookingId) return next(new AppError('Order selection is required for this issue', 400));
      booking = await prisma.booking.findFirst({
        where: { id: bookingId, userId: req.user.userId },
        select: { id: true, orderCode: true, status: true, vehicleType: true },
      });
      if (!booking) return next(new AppError('Order not found for this account', 404));
    }

    const path = findPath(ACTORS.CUSTOMER, issue.id);
    const intakeAnswers = {
      issueId: issue.id,
      displayPath: Array.isArray(displayPath) ? displayPath : [],
      answers: answers && typeof answers === 'object' ? answers : {},
    };
    const message = summarizeIntake({
      actor: ACTORS.CUSTOMER,
      issue,
      path,
      booking,
      details: trimmedDetails,
      answers: intakeAnswers.answers,
    });

    const ticket = await prisma.$transaction(async (tx) => {
      const created = await tx.supportTicket.create({
        data: {
          userId: req.user.userId,
          bookingId: booking?.id || null,
          subject: makeSubject({ actor: ACTORS.CUSTOMER, issue, booking }),
          category: issue.category,
          priority: issue.priority,
          source: 'AUTOMATION_BOT',
          intakePath: path,
          intakeAnswers,
          messages: {
            create: {
              senderId: req.user.userId,
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
        await tx.ticketAttachment.createMany({
          data: attachmentCreateMany({
            attachments: attachmentResult.attachments,
            ticketId: created.id,
            messageId: firstMessage.id,
            uploadedById: req.user.userId,
            uploadedByType: 'USER',
          }),
        });
      }

      return tx.supportTicket.findUnique({
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

// POST /api/support/tickets - Create a support ticket
router.post('/tickets', async (req, res, next) => {
  try {
    const { subject, category, message, bookingId, priority, attachments: rawAttachments } = req.body;
    console.log('[support] POST ticket — userId:', req.user.userId, 'subject:', subject, 'category:', category || 'OTHER', 'bookingId:', bookingId || 'none');
    if (!subject || !message) {
      return next(new AppError('Subject and message are required', 400));
    }

    const attachmentResult = validateAttachments(rawAttachments);
    if (!attachmentResult.ok) return next(new AppError(attachmentResult.message, 400));

    if (bookingId) {
      const booking = await prisma.booking.findFirst({
        where: { id: bookingId, userId: req.user.userId },
        select: { id: true },
      });
      if (!booking) return next(new AppError('Order not found for this account', 404));
    }

    const ticket = await prisma.$transaction(async (tx) => {
      const created = await tx.supportTicket.create({
        data: {
          userId: req.user.userId,
          bookingId: bookingId || null,
          subject,
          category: category || 'OTHER',
          priority: priority || 'MEDIUM',
          source: 'MANUAL',
          messages: {
            create: {
              senderId: req.user.userId,
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
        await tx.ticketAttachment.createMany({
          data: attachmentCreateMany({
            attachments: attachmentResult.attachments,
            ticketId: created.id,
            messageId: firstMessage.id,
            uploadedById: req.user.userId,
            uploadedByType: 'USER',
          }),
        });
      }
      return tx.supportTicket.findUnique({
        where: { id: created.id },
        include: { messages: { orderBy: { createdAt: 'asc' }, include: { attachments: true } } },
      });
    });

    console.log('[support] ticket created — ticketId:', ticket.id, 'userId:', req.user.userId, 'subject:', subject);
    res.status(201).json({ success: true, data: ticket });
  } catch (err) {
    next(err);
  }
});

// GET /api/support/tickets - List user's tickets
router.get('/tickets', async (req, res, next) => {
  try {
    const status = req.query.status;
    const where = { userId: req.user.userId };
    if (status) where.status = status;

    const tickets = await prisma.supportTicket.findMany({
      where,
      include: {
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        booking: { select: { id: true, status: true, vehicleType: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    res.json({ success: true, data: tickets });
  } catch (err) {
    next(err);
  }
});

// GET /api/support/tickets/:id - Get ticket details
router.get('/tickets/:id', async (req, res, next) => {
  try {
    const ticket = await prisma.supportTicket.findUnique({
      where: { id: req.params.id },
      include: {
        messages: {
          where: { isCustomerVisible: true },
          orderBy: { createdAt: 'asc' },
          include: { attachments: true },
        },
        booking: {
          select: {
            id: true,
            status: true,
            vehicleType: true,
            estimatedPrice: true,
            createdAt: true,
          },
        },
      },
    });

    if (!ticket) return next(new AppError('Ticket not found', 404));
    if (ticket.userId !== req.user.userId) return next(new AppError('Not authorized', 403));

    res.json({ success: true, data: ticket });
  } catch (err) {
    next(err);
  }
});

// POST /api/support/tickets/:id/reply - Reply to a ticket
router.post('/tickets/:id/reply', async (req, res, next) => {
  try {
    const { message, imageUrl, attachments: rawAttachments } = req.body;
    if (!message && (!Array.isArray(rawAttachments) || rawAttachments.length === 0)) {
      return next(new AppError('Message or attachment is required', 400));
    }

    const attachmentResult = validateAttachments(rawAttachments);
    if (!attachmentResult.ok) return next(new AppError(attachmentResult.message, 400));

    const ticket = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
    if (!ticket) return next(new AppError('Ticket not found', 404));
    if (ticket.userId !== req.user.userId) return next(new AppError('Not authorized', 403));
    if (ticket.status === 'CLOSED') return next(new AppError('Ticket is closed', 400));

    const ticketMessage = await prisma.$transaction(async (tx) => {
      const created = await tx.ticketMessage.create({
        data: {
          ticketId: req.params.id,
          senderId: req.user.userId,
          isStaff: false,
          messageType: 'USER_MESSAGE',
          isCustomerVisible: true,
          message: message || '',
          imageUrl: imageUrl || null,
        },
        include: { attachments: true },
      });
      if (attachmentResult.attachments.length > 0) {
        await tx.ticketAttachment.createMany({
          data: attachmentCreateMany({
            attachments: attachmentResult.attachments,
            ticketId: req.params.id,
            messageId: created.id,
            uploadedById: req.user.userId,
            uploadedByType: 'USER',
          }),
        });
      }
      await tx.supportTicket.update({
        where: { id: req.params.id },
        data: { status: ticket.status === 'RESOLVED' ? 'OPEN' : ticket.status },
      });
      return tx.ticketMessage.findUnique({
        where: { id: created.id },
        include: { attachments: true },
      });
    });

    res.status(201).json({ success: true, data: ticketMessage });
  } catch (err) {
    next(err);
  }
});

// POST /api/support/tickets/:id/close - Close a ticket
module.exports = router;
