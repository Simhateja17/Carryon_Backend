const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticateDriver, requireDriver } = require('../middleware/driverAuth');
const { AppError } = require('../middleware/errorHandler');

const router = Router();
router.use(authenticateDriver, requireDriver);

// GET /api/driver/chat/:bookingId — get messages (marks USER messages as read)
router.get('/:bookingId', async (req, res, next) => {
  try {
    console.log('[driver-chat] GET messages — driverId:', req.driver.id, 'bookingId:', req.params.bookingId);
    const booking = await prisma.booking.findUnique({ where: { id: req.params.bookingId } });
    if (!booking) return next(new AppError('Booking not found', 404));
    if (booking.driverId !== req.driver.id) return next(new AppError('Not authorized', 403));

    const messages = await prisma.chatMessage.findMany({
      where: { bookingId: req.params.bookingId },
      orderBy: { createdAt: 'asc' },
    });

    // Mark unread user messages as read
    await prisma.chatMessage.updateMany({
      where: {
        bookingId: req.params.bookingId,
        senderType: 'USER',
        isRead: false,
      },
      data: { isRead: true },
    });

    console.log('[driver-chat] GET messages — bookingId:', req.params.bookingId, 'messages:', messages.length);
    res.json({ success: true, data: messages });
  } catch (err) {
    next(err);
  }
});

// POST /api/driver/chat/:bookingId — send as DRIVER
router.post('/:bookingId', async (req, res, next) => {
  try {
    const { message, imageUrl } = req.body;
    console.log('[driver-chat] POST message — driverId:', req.driver.id, 'bookingId:', req.params.bookingId);
    if (!message && !imageUrl) return next(new AppError('Message or image is required', 400));

    const booking = await prisma.booking.findUnique({ where: { id: req.params.bookingId } });
    if (!booking) return next(new AppError('Booking not found', 404));
    if (booking.driverId !== req.driver.id) return next(new AppError('Not authorized', 403));

    const chatMessage = await prisma.chatMessage.create({
      data: {
        bookingId: req.params.bookingId,
        senderId: req.driver.id,
        senderType: 'DRIVER',
        message: message || '',
        imageUrl: imageUrl || null,
      },
    });

    console.log('[driver-chat] Message sent — msgId:', chatMessage.id, 'bookingId:', req.params.bookingId);
    res.status(201).json({ success: true, data: chatMessage });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
