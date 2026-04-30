const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticate } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');

const router = Router();
router.use(authenticate);

// GET /api/chat/:bookingId - Get all messages for a booking
router.get('/:bookingId', async (req, res, next) => {
  try {
    console.log('[chat] GET messages — userId:', req.user.userId, 'bookingId:', req.params.bookingId);
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

    console.log('[chat] GET messages — bookingId:', req.params.bookingId, 'messages:', messages.length);
    res.json({ success: true, data: messages });
  } catch (err) {
    next(err);
  }
});

// POST /api/chat/:bookingId - Send a message
router.post('/:bookingId', async (req, res, next) => {
  try {
    const { message, imageUrl } = req.body;
    console.log('[chat] POST message — userId:', req.user.userId, 'bookingId:', req.params.bookingId);
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

    console.log('[chat] Message sent — msgId:', chatMessage.id, 'bookingId:', req.params.bookingId);
    res.status(201).json({ success: true, data: chatMessage });
  } catch (err) {
    next(err);
  }
});

// GET /api/chat/:bookingId/unread - Get unread count
router.get('/:bookingId/unread', async (req, res, next) => {
  try {
    const booking = await prisma.booking.findFirst({
      where: { id: req.params.bookingId, userId: req.user.userId },
      select: { id: true },
    });
    if (!booking) return next(new AppError('Booking not found', 404));

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
    const quickMessages = (process.env.CHAT_QUICK_MESSAGES || '')
      .split('|')
      .map((item) => item.trim())
      .filter(Boolean);
    res.json({ success: true, data: quickMessages });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
