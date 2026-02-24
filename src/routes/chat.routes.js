const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticate } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');

const router = Router();
router.use(authenticate);

// GET /api/chat/:bookingId - Get all messages for a booking
router.get('/:bookingId', async (req, res, next) => {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.bookingId } });
    if (!booking) return next(new AppError('Booking not found', 404));
    if (booking.userId !== req.user.userId) return next(new AppError('Not authorized', 403));

    const messages = await prisma.chatMessage.findMany({
      where: { bookingId: req.params.bookingId },
      orderBy: { createdAt: 'asc' },
    });

    // Mark unread messages as read
    await prisma.chatMessage.updateMany({
      where: {
        bookingId: req.params.bookingId,
        senderType: 'DRIVER',
        isRead: false,
      },
      data: { isRead: true },
    });

    res.json({ success: true, data: messages });
  } catch (err) {
    next(err);
  }
});

// POST /api/chat/:bookingId - Send a message
router.post('/:bookingId', async (req, res, next) => {
  try {
    const { message, imageUrl } = req.body;
    if (!message && !imageUrl) return next(new AppError('Message or image is required', 400));

    const booking = await prisma.booking.findUnique({ where: { id: req.params.bookingId } });
    if (!booking) return next(new AppError('Booking not found', 404));
    if (booking.userId !== req.user.userId) return next(new AppError('Not authorized', 403));

    const chatMessage = await prisma.chatMessage.create({
      data: {
        bookingId: req.params.bookingId,
        senderId: req.user.userId,
        senderType: 'USER',
        message: message || '',
        imageUrl: imageUrl || null,
      },
    });

    res.status(201).json({ success: true, data: chatMessage });
  } catch (err) {
    next(err);
  }
});

// GET /api/chat/:bookingId/unread - Get unread count
router.get('/:bookingId/unread', async (req, res, next) => {
  try {
    const count = await prisma.chatMessage.count({
      where: {
        bookingId: req.params.bookingId,
        senderType: 'DRIVER',
        isRead: false,
      },
    });

    res.json({ success: true, data: { unreadCount: count } });
  } catch (err) {
    next(err);
  }
});

// Predefined quick messages
router.get('/:bookingId/quick-messages', async (req, res, next) => {
  try {
    const quickMessages = [
      'I am at the pickup location',
      'Please come to the gate',
      'I am running late, please wait',
      'Can you call me?',
      'Package is fragile, please handle with care',
      'I will be there in 5 minutes',
      'Where are you exactly?',
      'Thank you!',
    ];
    res.json({ success: true, data: quickMessages });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
