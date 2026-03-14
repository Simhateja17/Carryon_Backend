const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticate } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');

const router = Router();
router.use(authenticate);

// POST /api/support/tickets - Create a support ticket
router.post('/tickets', async (req, res, next) => {
  try {
    const { subject, category, message, bookingId, priority } = req.body;
    if (!subject || !message) {
      return next(new AppError('Subject and message are required', 400));
    }

    const ticket = await prisma.supportTicket.create({
      data: {
        userId: req.user.userId,
        bookingId: bookingId || null,
        subject,
        category: category || 'OTHER',
        priority: priority || 'MEDIUM',
        messages: {
          create: {
            senderId: req.user.userId,
            isStaff: false,
            message,
          },
        },
      },
      include: { messages: true },
    });

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
        messages: { orderBy: { createdAt: 'asc' } },
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
    const { message, imageUrl } = req.body;
    if (!message) return next(new AppError('Message is required', 400));

    const ticket = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
    if (!ticket) return next(new AppError('Ticket not found', 404));
    if (ticket.userId !== req.user.userId) return next(new AppError('Not authorized', 403));
    if (ticket.status === 'CLOSED') return next(new AppError('Ticket is closed', 400));

    const [ticketMessage] = await prisma.$transaction([
      prisma.ticketMessage.create({
        data: {
          ticketId: req.params.id,
          senderId: req.user.userId,
          isStaff: false,
          message,
          imageUrl: imageUrl || null,
        },
      }),
      prisma.supportTicket.update({
        where: { id: req.params.id },
        data: { status: 'OPEN' },
      }),
    ]);

    res.status(201).json({ success: true, data: ticketMessage });
  } catch (err) {
    next(err);
  }
});

// POST /api/support/tickets/:id/close - Close a ticket
router.post('/tickets/:id/close', async (req, res, next) => {
  try {
    const ticket = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
    if (!ticket) return next(new AppError('Ticket not found', 404));
    if (ticket.userId !== req.user.userId) return next(new AppError('Not authorized', 403));

    const updated = await prisma.supportTicket.update({
      where: { id: req.params.id },
      data: { status: 'CLOSED' },
    });

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
