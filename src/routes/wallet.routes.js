const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticate } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { getStripe, stripeCurrency } = require('../lib/stripe');
const { toMinorUnits, fromMinorUnits } = require('../lib/money');
const { parsePagination } = require('../lib/pagination');
const { parseBody } = require('../lib/validation');
const { payBookingFromWallet } = require('../services/walletLedger');
const { walletPaySchema, walletTopupIntentSchema } = require('../validation/financialSchemas');

const router = Router();
router.use(authenticate);

// GET /api/wallet
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

// POST /api/wallet/topup/intent
router.post('/topup/intent', async (req, res, next) => {
  try {
    const { amount } = parseBody(walletTopupIntentSchema, req.body);
    const amountMinor = toMinorUnits(amount);
    const minMinor = toMinorUnits(process.env.WALLET_TOPUP_MIN || 10);
    const maxMinor = toMinorUnits(process.env.WALLET_TOPUP_MAX || 1000);

    if (!amountMinor || amountMinor < minMinor) {
      return next(new AppError(`Minimum top-up is RM ${fromMinorUnits(minMinor)}`, 400));
    }
    if (amountMinor > maxMinor) {
      return next(new AppError(`Maximum top-up is RM ${fromMinorUnits(maxMinor)}`, 400));
    }

    const stripe = getStripe();
    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) return next(new AppError('User not found', 404));

    let stripeCustomerId = user.stripeCustomerId;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name || undefined,
        phone: user.phone || undefined,
        metadata: { userId: user.id },
      });
      stripeCustomerId = customer.id;
      await prisma.user.update({
        where: { id: user.id },
        data: { stripeCustomerId },
      });
    }

    const currency = stripeCurrency();
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountMinor,
      currency,
      customer: stripeCustomerId,
      payment_method_types: ['grabpay', 'fpx', 'card'],
      metadata: {
        userId: user.id,
        purpose: 'wallet_topup',
      },
    });

    await prisma.walletTopUpPayment.create({
      data: {
        userId: user.id,
        amount: fromMinorUnits(amountMinor),
        amountMinor,
        currency,
        status: 'PENDING',
        stripePaymentIntentId: paymentIntent.id,
      },
    });

    res.json({
      success: true,
      data: {
        paymentIntentId: paymentIntent.id,
        clientSecret: paymentIntent.client_secret,
        amount: fromMinorUnits(amountMinor),
        currency,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/wallet/topup — legacy disabled
router.post('/topup', async (req, res, next) => {
  try {
    return next(new AppError('Use /api/wallet/topup/intent for Stripe wallet top-ups', 410));
  } catch (err) {
    next(err);
  }
});

// POST /api/wallet/pay
router.post('/pay', async (req, res, next) => {
  try {
    const { bookingId } = parseBody(walletPaySchema, req.body);
    console.log('[wallet] POST pay — userId:', req.user.userId, 'bookingId:', bookingId);

    const result = await prisma.$transaction(async (tx) => {
      // Read booking inside transaction for transactional consistency
      const booking = await tx.booking.findUnique({ where: { id: bookingId } });
      if (!booking || booking.userId !== req.user.userId) {
        const err = new Error('Booking not found');
        err.statusCode = 404;
        throw err;
      }

      // Idempotency: if already paid, return current wallet without re-debiting
      if (booking.paymentStatus === 'COMPLETED') {
        const wallet = await tx.wallet.findUnique({ where: { userId: req.user.userId } });
        return { wallet, amount: booking.finalPrice || 0, alreadyPaid: true };
      }

      const walletResult = await payBookingFromWallet(tx, req.user.userId, booking);
      const amount = booking.estimatedPrice - booking.discountAmount;
      return { wallet: walletResult, amount, alreadyPaid: false };
    });

    console.log('[wallet] pay — userId:', req.user.userId, 'bookingId:', bookingId, 'amount:', result.amount, 'alreadyPaid:', result.alreadyPaid, 'balance:', result.wallet?.balance);
    res.json({ success: true, data: { balance: result.wallet?.balance, amountPaid: result.amount } });
  } catch (err) {
    next(err);
  }
});

// GET /api/wallet/transactions
router.get('/transactions', async (req, res, next) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);

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
