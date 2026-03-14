const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticate } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');

const router = Router();
router.use(authenticate);

// GET /api/wallet - Get wallet balance and recent transactions
router.get('/', async (req, res, next) => {
  try {
    let wallet = await prisma.wallet.findUnique({
      where: { userId: req.user.userId },
      include: {
        transactions: {
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
    });

    if (!wallet) {
      wallet = await prisma.wallet.create({
        data: { userId: req.user.userId },
        include: { transactions: true },
      });
    }

    res.json({ success: true, data: wallet });
  } catch (err) {
    next(err);
  }
});

// POST /api/wallet/topup - Top up wallet
router.post('/topup', async (req, res, next) => {
  try {
    const { amount, paymentReference } = req.body;
    if (!amount || amount <= 0) return next(new AppError('Invalid amount', 400));
    if (amount > 1000) return next(new AppError('Maximum top-up is RM 1000', 400));

    const wallet = await prisma.wallet.upsert({
      where: { userId: req.user.userId },
      create: { userId: req.user.userId, balance: amount },
      update: { balance: { increment: amount } },
    });

    await prisma.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: 'TOP_UP',
        amount,
        description: 'Wallet top-up',
        referenceId: paymentReference || null,
      },
    });

    const updated = await prisma.wallet.findUnique({ where: { id: wallet.id } });
    res.json({ success: true, data: { balance: updated.balance } });
  } catch (err) {
    next(err);
  }
});

// POST /api/wallet/pay - Pay for a booking using wallet
router.post('/pay', async (req, res, next) => {
  try {
    const { bookingId } = req.body;
    if (!bookingId) return next(new AppError('Booking ID is required', 400));

    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking || booking.userId !== req.user.userId) {
      return next(new AppError('Booking not found', 404));
    }

    const amount = booking.estimatedPrice - booking.discountAmount;

    const wallet = await prisma.wallet.findUnique({ where: { userId: req.user.userId } });
    if (!wallet || wallet.balance < amount) {
      return next(new AppError('Insufficient wallet balance', 400));
    }

    await prisma.$transaction([
      prisma.wallet.update({
        where: { id: wallet.id },
        data: { balance: { decrement: amount } },
      }),
      prisma.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: 'PAYMENT',
          amount: -amount,
          description: `Payment for booking`,
          referenceId: bookingId,
        },
      }),
      prisma.booking.update({
        where: { id: bookingId },
        data: { paymentMethod: 'WALLET', paymentStatus: 'COMPLETED', finalPrice: amount },
      }),
    ]);

    const updated = await prisma.wallet.findUnique({ where: { id: wallet.id } });
    res.json({ success: true, data: { balance: updated.balance, amountPaid: amount } });
  } catch (err) {
    next(err);
  }
});

// GET /api/wallet/transactions - Get paginated transactions
router.get('/transactions', async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const wallet = await prisma.wallet.findUnique({ where: { userId: req.user.userId } });
    if (!wallet) return res.json({ success: true, data: { transactions: [], total: 0 } });

    const [transactions, total] = await Promise.all([
      prisma.walletTransaction.findMany({
        where: { walletId: wallet.id },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.walletTransaction.count({ where: { walletId: wallet.id } }),
    ]);

    res.json({ success: true, data: { transactions, total, page, limit } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
