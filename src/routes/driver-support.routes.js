const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticateDriver, requireDriver } = require('../middleware/driverAuth');
const { AppError } = require('../middleware/errorHandler');

const router = Router();
router.use(authenticateDriver, requireDriver);

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
    const { subject, category, description } = req.body;
    console.log('[driver-support] POST ticket — driverId:', req.driver.id, 'subject:', subject, 'category:', category || 'GENERAL');
    if (!subject) return next(new AppError('Subject is required', 400));

    const ticket = await prisma.driverSupportTicket.create({
      data: {
        driverId: req.driver.id,
        subject,
        category: category || 'GENERAL',
        description: description || '',
        messages: {
          create: {
            senderId: req.driver.id,
            message: description || subject,
          },
        },
      },
      include: { messages: true },
    });

    console.log('[driver-support] ticket created — ticketId:', ticket.id, 'driverId:', req.driver.id, 'subject:', subject);
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
      include: { messages: { orderBy: { createdAt: 'asc' } } },
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
    const { message } = req.body;
    if (!message) return next(new AppError('Message is required', 400));

    const ticket = await prisma.driverSupportTicket.findUnique({ where: { id: req.params.id } });
    if (!ticket) return next(new AppError('Ticket not found', 404));
    if (ticket.driverId !== req.driver.id) return next(new AppError('Not authorized', 403));

    const ticketMessage = await prisma.driverTicketMessage.create({
      data: {
        ticketId: req.params.id,
        senderId: req.driver.id,
        message,
      },
    });

    // Re-open if resolved
    if (ticket.status === 'RESOLVED' || ticket.status === 'CLOSED') {
      await prisma.driverSupportTicket.update({
        where: { id: req.params.id },
        data: { status: 'OPEN' },
      });
    }

    res.status(201).json({ success: true, data: ticketMessage });
  } catch (err) {
    next(err);
  }
});

// POST /api/driver/support/sos — emergency
router.post('/sos', async (req, res, next) => {
  try {
    const { latitude, longitude } = req.body;
    console.log('[driver-support] POST SOS — driverId:', req.driver.id, 'location:', latitude, longitude);

    const ticket = await prisma.driverSupportTicket.create({
      data: {
        driverId: req.driver.id,
        subject: 'SOS Emergency',
        category: 'GENERAL',
        description: `Emergency SOS triggered at location: ${latitude}, ${longitude}`,
        priority: 'URGENT',
        messages: {
          create: {
            senderId: req.driver.id,
            message: `SOS Emergency! Location: ${latitude}, ${longitude}`,
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

    res.status(201).json({ success: true, data: ticket });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
