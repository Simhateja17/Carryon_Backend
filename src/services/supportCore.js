/**
 * Shared support ticket logic for both customer and driver support routes.
 *
 * Uses the ticketModels() pattern (proven in adminSupport.js) to parametrize
 * Prisma model access by actor type, eliminating ~92% duplication.
 *
 * Actor config:
 *   { actorType, getActorId, ownerField, uploadPrefix, bookingOwnerField, models(db) }
 */
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { uploadToSupabase } = require('../lib/supabase');
const {
  attachmentCreateMany,
  validateAttachments,
} = require('./supportAttachments');
const {
  ACTORS,
  findIssue,
  findPath,
  makeSubject,
  summarizeIntake,
} = require('./supportIntake');

/**
 * Returns Prisma model accessors for the given actor type.
 */
function ticketModels(db, actorType) {
  return actorType === 'CUSTOMER'
    ? { ticket: db.supportTicket, message: db.ticketMessage, attachment: db.ticketAttachment }
    : { ticket: db.driverSupportTicket, message: db.driverTicketMessage, attachment: db.driverTicketAttachment };
}

async function uploadAttachment(req, next, { getActorId, uploadPrefix }) {
  if (!req.file) return next(new AppError('No attachment file provided', 400));
  const ext = req.file.originalname.split('.').pop() || 'bin';
  const path = `${uploadPrefix}/${getActorId(req)}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const fileUrl = await uploadToSupabase('support-attachments', req.file, path);
  return {
    success: true,
    data: { fileUrl, storagePath: fileUrl, mimeType: req.file.mimetype, fileSize: req.file.size },
  };
}

async function createIntakeTicket(req, next, actor) {
  const { issueId, bookingId, details, answers, attachments: rawAttachments, displayPath } = req.body || {};
  const intakeActor = actor.actorType === 'CUSTOMER' ? ACTORS.CUSTOMER : ACTORS.DRIVER;
  const issue = findIssue(intakeActor, issueId);
  if (!issue) return next(new AppError('Unsupported support issue', 400));
  if (issue.emergency) return next(new AppError('Use the SOS endpoint for emergency support', 400));

  const trimmedDetails = typeof details === 'string' ? details.trim() : '';
  if (issue.requiresDetails && trimmedDetails.length < 3) {
    return next(new AppError('Issue details are required', 400));
  }

  const attachmentResult = validateAttachments(rawAttachments);
  if (!attachmentResult.ok) return next(new AppError(attachmentResult.message, 400));

  const actorId = actor.getActorId(req);
  let booking = null;
  if (issue.requiresBooking || bookingId) {
    if (!bookingId) return next(new AppError('Order selection is required for this issue', 400));
    booking = await prisma.booking.findFirst({
      where: { id: bookingId, [actor.bookingOwnerField]: actorId },
      select: { id: true, orderCode: true, status: true, vehicleType: true },
    });
    if (!booking) return next(new AppError('Order not found for this account', 404));
  }

  const path = findPath(intakeActor, issue.id);
  const intakeAnswers = {
    issueId: issue.id,
    displayPath: Array.isArray(displayPath) ? displayPath : [],
    answers: answers && typeof answers === 'object' ? answers : {},
  };
  const message = summarizeIntake({
    actor: intakeActor,
    issue,
    path,
    booking,
    details: trimmedDetails,
    answers: intakeAnswers.answers,
  });

  const { ticket: ticketModel, attachment: attachmentModel } = ticketModels(prisma, actor.actorType);
  const ticket = await prisma.$transaction(async (tx) => {
    const models = ticketModels(tx, actor.actorType);
    const ownerData = actor.actorType === 'CUSTOMER'
      ? { userId: actorId }
      : { driverId: actorId, description: trimmedDetails };

    const created = await models.ticket.create({
      data: {
        ...ownerData,
        bookingId: booking?.id || null,
        subject: makeSubject({ actor: intakeActor, issue, booking }),
        category: issue.category,
        priority: issue.priority,
        source: 'AUTOMATION_BOT',
        intakePath: path,
        intakeAnswers,
        messages: {
          create: {
            senderId: actorId,
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
      await models.attachment.createMany({
        data: attachmentCreateMany({
          attachments: attachmentResult.attachments,
          ticketId: created.id,
          messageId: firstMessage.id,
          uploadedById: actorId,
          uploadedByType: actor.actorType === 'CUSTOMER' ? 'USER' : 'DRIVER',
        }),
      });
    }

    return models.ticket.findUnique({
      where: { id: created.id },
      include: {
        messages: { orderBy: { createdAt: 'asc' }, include: { attachments: true } },
        booking: { select: { id: true, orderCode: true, status: true, vehicleType: true } },
      },
    });
  });

  return { success: true, data: ticket };
}

async function createManualTicket(req, next, actor) {
  const { subject, category, message, description, bookingId, priority, attachments: rawAttachments } = req.body;
  const actorId = actor.getActorId(req);
  const logPrefix = actor.actorType === 'CUSTOMER' ? 'support' : 'driver-support';
  console.log(`[${logPrefix}] POST ticket — actorId:`, actorId, 'subject:', subject, 'category:', category || 'OTHER');

  if (!subject) return next(new AppError('Subject is required', 400));
  const body = message || description || '';
  if (actor.actorType === 'CUSTOMER' && !body) return next(new AppError('Subject and message are required', 400));

  const attachmentResult = validateAttachments(rawAttachments);
  if (!attachmentResult.ok) return next(new AppError(attachmentResult.message, 400));

  if (bookingId) {
    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, [actor.bookingOwnerField]: actorId },
      select: { id: true },
    });
    if (!booking) return next(new AppError('Order not found for this account', 404));
  }

  const ticket = await prisma.$transaction(async (tx) => {
    const models = ticketModels(tx, actor.actorType);
    const ownerData = actor.actorType === 'CUSTOMER'
      ? { userId: actorId }
      : { driverId: actorId, description: body };

    const created = await models.ticket.create({
      data: {
        ...ownerData,
        bookingId: bookingId || null,
        subject,
        category: category || 'OTHER',
        priority: priority || 'MEDIUM',
        source: 'MANUAL',
        messages: {
          create: {
            senderId: actorId,
            isStaff: false,
            messageType: 'USER_MESSAGE',
            isCustomerVisible: true,
            message: body || subject,
          },
        },
      },
      include: { messages: true },
    });
    const firstMessage = created.messages[0];
    if (firstMessage && attachmentResult.attachments.length > 0) {
      await models.attachment.createMany({
        data: attachmentCreateMany({
          attachments: attachmentResult.attachments,
          ticketId: created.id,
          messageId: firstMessage.id,
          uploadedById: actorId,
          uploadedByType: actor.actorType === 'CUSTOMER' ? 'USER' : 'DRIVER',
        }),
      });
    }
    return models.ticket.findUnique({
      where: { id: created.id },
      include: { messages: { orderBy: { createdAt: 'asc' }, include: { attachments: true } } },
    });
  });

  console.log(`[${logPrefix}] ticket created — ticketId:`, ticket.id, 'actorId:', actorId, 'subject:', subject);
  return { success: true, data: ticket };
}

async function listTickets(req, _next, actor) {
  const actorId = actor.getActorId(req);
  const models = ticketModels(prisma, actor.actorType);
  const ownerFilter = actor.actorType === 'CUSTOMER'
    ? { userId: actorId }
    : { driverId: actorId };
  const where = { ...ownerFilter };
  if (req.query.status) where.status = req.query.status;

  const tickets = await models.ticket.findMany({
    where,
    include: {
      messages: { orderBy: { createdAt: actor.actorType === 'CUSTOMER' ? 'desc' : 'asc' }, ...(actor.actorType === 'CUSTOMER' ? { take: 1 } : {}) },
      ...(actor.actorType === 'CUSTOMER' ? { booking: { select: { id: true, status: true, vehicleType: true } } } : {}),
    },
    orderBy: { [actor.actorType === 'CUSTOMER' ? 'updatedAt' : 'createdAt']: 'desc' },
  });

  return { success: true, data: tickets };
}

async function getTicket(req, next, actor) {
  const actorId = actor.getActorId(req);
  const models = ticketModels(prisma, actor.actorType);

  const ticket = await models.ticket.findUnique({
    where: { id: req.params.id },
    include: {
      messages: {
        where: { isCustomerVisible: true },
        orderBy: { createdAt: 'asc' },
        include: { attachments: true },
      },
      ...(actor.actorType === 'CUSTOMER' ? {
        booking: { select: { id: true, status: true, vehicleType: true, estimatedPrice: true, createdAt: true } },
      } : {}),
    },
  });

  if (!ticket) return next(new AppError('Ticket not found', 404));
  const ownerId = actor.actorType === 'CUSTOMER' ? ticket.userId : ticket.driverId;
  if (ownerId !== actorId) return next(new AppError('Not authorized', 403));

  return { success: true, data: ticket };
}

async function replyToTicket(req, next, actor) {
  const { message, imageUrl, attachments: rawAttachments } = req.body;
  if (!message && (!Array.isArray(rawAttachments) || rawAttachments.length === 0)) {
    return next(new AppError('Message or attachment is required', 400));
  }
  const attachmentResult = validateAttachments(rawAttachments);
  if (!attachmentResult.ok) return next(new AppError(attachmentResult.message, 400));

  const actorId = actor.getActorId(req);
  const models = ticketModels(prisma, actor.actorType);
  const ticket = await models.ticket.findUnique({ where: { id: req.params.id } });
  if (!ticket) return next(new AppError('Ticket not found', 404));
  const ownerId = actor.actorType === 'CUSTOMER' ? ticket.userId : ticket.driverId;
  if (ownerId !== actorId) return next(new AppError('Not authorized', 403));
  if (ticket.status === 'CLOSED') return next(new AppError('Ticket is closed', 400));

  const ticketMessage = await prisma.$transaction(async (tx) => {
    const txModels = ticketModels(tx, actor.actorType);
    const created = await txModels.message.create({
      data: {
        ticketId: req.params.id,
        senderId: actorId,
        isStaff: false,
        messageType: 'USER_MESSAGE',
        isCustomerVisible: true,
        message: message || '',
        ...(imageUrl ? { imageUrl } : {}),
      },
      include: { attachments: true },
    });
    if (attachmentResult.attachments.length > 0) {
      await txModels.attachment.createMany({
        data: attachmentCreateMany({
          attachments: attachmentResult.attachments,
          ticketId: req.params.id,
          messageId: created.id,
          uploadedById: actorId,
          uploadedByType: actor.actorType === 'CUSTOMER' ? 'USER' : 'DRIVER',
        }),
      });
    }
    const reopenStatus = ticket.status === 'RESOLVED' ? 'OPEN' : ticket.status;
    if (reopenStatus !== ticket.status) {
      await txModels.ticket.update({ where: { id: req.params.id }, data: { status: reopenStatus } });
    }
    return txModels.message.findUnique({
      where: { id: created.id },
      include: { attachments: true },
    });
  });

  return { success: true, data: ticketMessage };
}

module.exports = {
  uploadAttachment,
  createIntakeTicket,
  createManualTicket,
  listTickets,
  getTicket,
  replyToTicket,
};
