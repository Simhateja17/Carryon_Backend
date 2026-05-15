const { AppError } = require('../middleware/errorHandler');
const { attachmentCreateMany, validateAttachments } = require('./supportAttachments');

const REQUESTER_TYPES = new Set(['CUSTOMER', 'DRIVER']);
const STATUS_VALUES = new Set(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']);

function requesterType(input) {
  const value = String(input || '').toUpperCase();
  if (!REQUESTER_TYPES.has(value)) throw new AppError('Unsupported requester type', 400);
  return value;
}

function parseTicketKey(input) {
  const [rawType, id] = String(input || '').split(':');
  const type = requesterType(rawType);
  if (!id) throw new AppError('Invalid ticket id', 400);
  return { type, id };
}

function publicTicketId(type, id) {
  return `${type}:${id}`;
}

function normalizeCustomerTicket(ticket) {
  return {
    id: publicTicketId('CUSTOMER', ticket.id),
    rawId: ticket.id,
    requesterType: 'CUSTOMER',
    requester: ticket.user ? {
      id: ticket.user.id,
      name: ticket.user.name,
      email: ticket.user.email,
      phone: ticket.user.phone,
    } : null,
    booking: ticket.booking ? {
      id: ticket.booking.id,
      orderCode: ticket.booking.orderCode,
      status: ticket.booking.status,
      vehicleType: ticket.booking.vehicleType,
    } : null,
    subject: ticket.subject,
    category: ticket.category,
    status: ticket.status,
    priority: ticket.priority,
    source: ticket.source || 'MANUAL',
    intakePath: ticket.intakePath || null,
    intakeAnswers: ticket.intakeAnswers || null,
    assignedAdminId: ticket.assignedAdminId || null,
    assignedAdminEmail: ticket.assignedAdminEmail || null,
    assignedAt: ticket.assignedAt || null,
    resolvedAt: ticket.resolvedAt || null,
    closedAt: ticket.closedAt || null,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    lastMessage: ticket.messages?.[0] ? normalizeMessage('CUSTOMER', ticket.messages[0]) : null,
  };
}

function normalizeDriverTicket(ticket) {
  return {
    id: publicTicketId('DRIVER', ticket.id),
    rawId: ticket.id,
    requesterType: 'DRIVER',
    requester: ticket.driver ? {
      id: ticket.driver.id,
      name: ticket.driver.name,
      email: ticket.driver.email,
      phone: ticket.driver.phone,
    } : null,
    booking: ticket.booking ? {
      id: ticket.booking.id,
      orderCode: ticket.booking.orderCode,
      status: ticket.booking.status,
      vehicleType: ticket.booking.vehicleType,
    } : null,
    subject: ticket.subject,
    category: ticket.category,
    status: ticket.status,
    priority: ticket.priority,
    source: ticket.source || 'MANUAL',
    intakePath: ticket.intakePath || null,
    intakeAnswers: ticket.intakeAnswers || null,
    assignedAdminId: ticket.assignedAdminId || null,
    assignedAdminEmail: ticket.assignedAdminEmail || null,
    assignedAt: ticket.assignedAt || null,
    resolvedAt: ticket.resolvedAt || null,
    closedAt: ticket.closedAt || null,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    lastMessage: ticket.messages?.[0] ? normalizeMessage('DRIVER', ticket.messages[0]) : null,
  };
}

function normalizeMessage(ticketType, message) {
  return {
    id: message.id,
    ticketId: publicTicketId(ticketType, message.ticketId),
    rawTicketId: message.ticketId,
    senderId: message.senderId,
    isStaff: message.isStaff,
    messageType: message.messageType || (message.isStaff ? 'STAFF_MESSAGE' : 'USER_MESSAGE'),
    isCustomerVisible: message.isCustomerVisible !== false,
    message: message.message,
    imageUrl: message.imageUrl || null,
    attachments: message.attachments || [],
    createdAt: message.createdAt,
  };
}

async function listSupportTickets(db, query = {}) {
  const where = {};
  if (query.status && query.status !== 'ALL') where.status = String(query.status).toUpperCase();
  if (query.priority && query.priority !== 'ALL') where.priority = String(query.priority).toUpperCase();
  if (query.assigned === 'me' && query.actorId) where.assignedAdminId = query.actorId;

  const search = typeof query.search === 'string' ? query.search.trim().slice(0, 100) : '';
  const includeCustomer = !query.requesterType || query.requesterType === 'CUSTOMER' || query.requesterType === 'ALL';
  const includeDriver = !query.requesterType || query.requesterType === 'DRIVER' || query.requesterType === 'ALL';

  const [customerTickets, driverTickets] = await Promise.all([
    includeCustomer ? db.supportTicket.findMany({
      where: {
        ...where,
        ...(search ? {
          OR: [
            { subject: { contains: search, mode: 'insensitive' } },
            { user: { name: { contains: search, mode: 'insensitive' } } },
            { user: { email: { contains: search, mode: 'insensitive' } } },
            { booking: { orderCode: { contains: search, mode: 'insensitive' } } },
          ],
        } : {}),
      },
      include: {
        user: { select: { id: true, name: true, email: true, phone: true } },
        booking: { select: { id: true, orderCode: true, status: true, vehicleType: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1, include: { attachments: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    }) : [],
    includeDriver ? db.driverSupportTicket.findMany({
      where: {
        ...where,
        ...(search ? {
          OR: [
            { subject: { contains: search, mode: 'insensitive' } },
            { driver: { name: { contains: search, mode: 'insensitive' } } },
            { driver: { email: { contains: search, mode: 'insensitive' } } },
            { booking: { orderCode: { contains: search, mode: 'insensitive' } } },
          ],
        } : {}),
      },
      include: {
        driver: { select: { id: true, name: true, email: true, phone: true } },
        booking: { select: { id: true, orderCode: true, status: true, vehicleType: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1, include: { attachments: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    }) : [],
  ]);

  return [...customerTickets.map(normalizeCustomerTicket), ...driverTickets.map(normalizeDriverTicket)]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 100);
}

async function getSupportTicket(db, key) {
  const { type, id } = parseTicketKey(key);
  if (type === 'CUSTOMER') {
    const ticket = await db.supportTicket.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true, email: true, phone: true } },
        booking: { select: { id: true, orderCode: true, status: true, vehicleType: true } },
        messages: { orderBy: { createdAt: 'asc' }, include: { attachments: true } },
      },
    });
    if (!ticket) throw new AppError('Ticket not found', 404);
    return { ...normalizeCustomerTicket(ticket), messages: ticket.messages.map((m) => normalizeMessage('CUSTOMER', m)) };
  }
  const ticket = await db.driverSupportTicket.findUnique({
    where: { id },
    include: {
      driver: { select: { id: true, name: true, email: true, phone: true } },
      booking: { select: { id: true, orderCode: true, status: true, vehicleType: true } },
      messages: { orderBy: { createdAt: 'asc' }, include: { attachments: true } },
    },
  });
  if (!ticket) throw new AppError('Ticket not found', 404);
  return { ...normalizeDriverTicket(ticket), messages: ticket.messages.map((m) => normalizeMessage('DRIVER', m)) };
}

function ticketModels(db, type) {
  return type === 'CUSTOMER'
    ? { ticket: db.supportTicket, message: db.ticketMessage, attachment: db.ticketAttachment, publicType: 'CUSTOMER' }
    : { ticket: db.driverSupportTicket, message: db.driverTicketMessage, attachment: db.driverTicketAttachment, publicType: 'DRIVER' };
}

async function addAdminReply(db, key, body, actor) {
  const { type, id } = parseTicketKey(key);
  const { ticket, message, attachment, publicType } = ticketModels(db, type);
  const text = typeof body.message === 'string' ? body.message.trim() : '';
  const messageType = body.internal ? 'INTERNAL_NOTE' : 'STAFF_MESSAGE';
  const visible = !body.internal;
  if (!text && (!Array.isArray(body.attachments) || body.attachments.length === 0)) {
    throw new AppError('Message or attachment is required', 400);
  }
  const attachmentResult = validateAttachments(body.attachments);
  if (!attachmentResult.ok) throw new AppError(attachmentResult.message, 400);

  const existing = await ticket.findUnique({ where: { id } });
  if (!existing) throw new AppError('Ticket not found', 404);
  if (existing.status === 'CLOSED') throw new AppError('Ticket is closed', 400);

  const created = await db.$transaction(async (tx) => {
    const models = ticketModels(tx, type);
    const msg = await models.message.create({
      data: {
        ticketId: id,
        senderId: actor?.actorId || 'admin',
        isStaff: true,
        messageType,
        isCustomerVisible: visible,
        message: text,
      },
    });
    if (attachmentResult.attachments.length > 0) {
      await models.attachment.createMany({
        data: attachmentCreateMany({
          attachments: attachmentResult.attachments,
          ticketId: id,
          messageId: msg.id,
          uploadedById: actor?.actorId || 'admin',
          uploadedByType: 'ADMIN',
        }),
      });
    }
    await models.ticket.update({
      where: { id },
      data: {
        status: existing.status === 'OPEN' ? 'IN_PROGRESS' : existing.status,
      },
    });
    return models.message.findUnique({
      where: { id: msg.id },
      include: { attachments: true },
    });
  });

  return normalizeMessage(publicType, created);
}

async function updateTicketStatus(db, key, status, actor) {
  const nextStatus = String(status || '').toUpperCase();
  if (!STATUS_VALUES.has(nextStatus)) throw new AppError('Unsupported ticket status', 400);
  const { type, id } = parseTicketKey(key);
  const { ticket, message, publicType } = ticketModels(db, type);
  const existing = await ticket.findUnique({ where: { id } });
  if (!existing) throw new AppError('Ticket not found', 404);

  const now = new Date();
  const data = {
    status: nextStatus,
    resolvedAt: nextStatus === 'RESOLVED' ? now : existing.resolvedAt,
    closedAt: nextStatus === 'CLOSED' ? now : existing.closedAt,
  };
  const systemText = nextStatus === 'IN_PROGRESS'
    ? 'Support started working on your ticket.'
    : nextStatus === 'RESOLVED'
      ? 'Your ticket was resolved.'
      : nextStatus === 'CLOSED'
        ? 'Your ticket was closed.'
        : 'Your ticket was reopened.';

  await db.$transaction(async (tx) => {
    const models = ticketModels(tx, type);
    await models.ticket.update({ where: { id }, data });
    await models.message.create({
      data: {
        ticketId: id,
        senderId: actor?.actorId || 'admin',
        isStaff: true,
        messageType: 'SYSTEM_EVENT',
        isCustomerVisible: true,
        message: systemText,
      },
    });
  });
  return getSupportTicket(db, publicTicketId(publicType, id));
}

async function assignTicket(db, key, actor) {
  const { type, id } = parseTicketKey(key);
  const { ticket, message, publicType } = ticketModels(db, type);
  const existing = await ticket.findUnique({ where: { id } });
  if (!existing) throw new AppError('Ticket not found', 404);
  const now = new Date();
  await db.$transaction(async (tx) => {
    const models = ticketModels(tx, type);
    await models.ticket.update({
      where: { id },
      data: {
        assignedAdminId: actor?.actorId || 'admin',
        assignedAdminEmail: actor?.actorEmail || null,
        assignedAt: now,
        status: existing.status === 'OPEN' ? 'IN_PROGRESS' : existing.status,
      },
    });
    await models.message.create({
      data: {
        ticketId: id,
        senderId: actor?.actorId || 'admin',
        isStaff: true,
        messageType: 'SYSTEM_EVENT',
        isCustomerVisible: true,
        message: 'Support started working on your ticket.',
      },
    });
  });
  return getSupportTicket(db, publicTicketId(publicType, id));
}

module.exports = {
  addAdminReply,
  assignTicket,
  getSupportTicket,
  listSupportTickets,
  parseTicketKey,
  updateTicketStatus,
};
