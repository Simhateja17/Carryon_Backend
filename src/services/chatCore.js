/**
 * Shared chat logic for both customer and driver chat routes.
 *
 * Each route file provides an actor config:
 *   { getActorId, senderType, opponentType, bookingOwnerField, logPrefix }
 *
 * This eliminates ~95% duplication between chat.routes.js and driver-chat.routes.js.
 */
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');

async function getMessages(req, next, { getActorId, opponentType, bookingOwnerField, logPrefix }) {
  const actorId = getActorId(req);
  const { bookingId } = req.params;
  console.log(`[${logPrefix}] GET messages — actorId:`, actorId, 'bookingId:', bookingId);

  const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!booking) return next(new AppError('Booking not found', 404));
  if (booking[bookingOwnerField] !== actorId) return next(new AppError('Not authorized', 403));

  const messages = await prisma.chatMessage.findMany({
    where: { bookingId },
    orderBy: { createdAt: 'asc' },
  });

  await prisma.chatMessage.updateMany({
    where: { bookingId, senderType: opponentType, isRead: false },
    data: { isRead: true },
  });

  console.log(`[${logPrefix}] GET messages — bookingId:`, bookingId, 'messages:', messages.length);
  return { success: true, data: messages };
}

async function sendMessage(req, next, { getActorId, senderType, bookingOwnerField, logPrefix }) {
  const actorId = getActorId(req);
  const { bookingId } = req.params;
  const { message, imageUrl } = req.body;
  console.log(`[${logPrefix}] POST message — actorId:`, actorId, 'bookingId:', bookingId);

  if (!message && !imageUrl) return next(new AppError('Message or image is required', 400));

  const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!booking) return next(new AppError('Booking not found', 404));
  if (booking[bookingOwnerField] !== actorId) return next(new AppError('Not authorized', 403));

  const chatMessage = await prisma.chatMessage.create({
    data: {
      bookingId,
      senderId: actorId,
      senderType,
      message: message || '',
      imageUrl: imageUrl || null,
    },
  });

  console.log(`[${logPrefix}] Message sent — msgId:`, chatMessage.id, 'bookingId:', bookingId);
  return { success: true, data: chatMessage };
}

async function getUnreadCount(req, next, { getActorId, opponentType }) {
  const actorId = getActorId(req);
  const { bookingId } = req.params;

  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, [bookingOwnerField(req)]: actorId },
    select: { id: true },
  });
  if (!booking) return next(new AppError('Booking not found', 404));

  const count = await prisma.chatMessage.count({
    where: { bookingId, senderType: opponentType, isRead: false },
  });

  return { success: true, data: { unreadCount: count } };
}

function getQuickMessages() {
  const quickMessages = (process.env.CHAT_QUICK_MESSAGES || '')
    .split('|')
    .map((item) => item.trim())
    .filter(Boolean);
  return { success: true, data: quickMessages };
}

module.exports = { getMessages, sendMessage, getQuickMessages };
