const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const prisma = require('../lib/prisma');
const { authenticate } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { getGenAI } = require('../lib/gemini');

const router = Router();

const aiChatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many requests. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/support/ai-chat
router.post('/ai-chat', authenticate, aiChatLimiter, async (req, res, next) => {
  try {
    const { message, history = [] } = req.body;
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return next(new AppError('Message is required', 400));
    }
    if (message.length > 1000) {
      return next(new AppError('Message is too long', 400));
    }

    // Fetch user's recent bookings for context — minimized for privacy
    const recentBookings = await prisma.booking.findMany({
      where: { userId: req.user.userId },
      take: 3,
      orderBy: { createdAt: 'desc' },
      select: {
        orderCode: true,
        status: true,
        vehicleType: true,
        createdAt: true,
      },
    });

    // Send only non-identifying display fields to AI
    const bookingContext = recentBookings.length > 0
      ? JSON.stringify(recentBookings.map(b => ({
          orderCode: b.orderCode || 'N/A',
          status: b.status,
          vehicleType: b.vehicleType,
          createdAt: b.createdAt,
        })), null, 2)
      : 'No recent bookings found.';

    const systemPrompt = `You are CarryOn's AI support assistant. CarryOn is a logistics and delivery platform in Malaysia that connects users with drivers for package delivery.

Help users with:
- Order/shipment tracking and status updates
- Changing delivery address (only possible before pickup)
- Delivery charges and pricing
- Package damage or loss claims → always direct to "Report Issue" in the app
- Booking cancellations
- App navigation and how-to questions
- Wallet and payment queries → direct to "Call Support" for disputes

Guidelines:
- Keep replies short, friendly, and specific
- Use the user's booking data below to give accurate, personalised answers
- For damaged or lost packages, always say: "Please use the Report Issue option in the app to file a claim."
- For billing disputes or urgent issues, say: "Please use Call Support for immediate assistance."
- Do not make up order details not present in the booking data
- Respond in the same language the user writes in

User's recent bookings:
${bookingContext}`;

    // Convert history from client format [{role, parts: string}] to Gemini format [{role, parts: [{text}]}]
    const formattedHistory = history
      .filter(h => h && h.role && typeof h.parts === 'string')
      .map(h => ({
        role: h.role,
        parts: [{ text: h.parts }],
      }));

    const model = getGenAI().getGenerativeModel({
      model: 'gemini-3.1-flash-lite-preview',
      systemInstruction: systemPrompt,
    });

    const chat = model.startChat({ history: formattedHistory });
    const result = await chat.sendMessage(message.trim());
    const reply = result.response.text();

    console.log('[support-ai] userId:', req.user.userId, 'msg length:', message.length, 'history turns:', formattedHistory.length);
    res.json({ success: true, data: { reply } });
  } catch (err) {
    console.error('[support-ai] error:', err.message);
    next(err);
  }
});

module.exports = router;
