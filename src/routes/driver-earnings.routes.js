const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticateDriver, requireDriver } = require('../middleware/driverAuth');
const { parsePagination } = require('../lib/pagination');
const { onlineHoursForWindow } = require('../services/driverOnlineTime');

const router = Router();
router.use(authenticateDriver, requireDriver);

// GET /api/driver/earnings/summary
router.get('/summary', async (req, res, next) => {
  try {
    const wallet = await prisma.driverWallet.findUnique({
      where: { driverId: req.driver.id },
      include: { transactions: true },
    });

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(startOfToday);
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const earnings = wallet?.transactions.filter(t => t.type === 'DELIVERY_EARNING' && t.status === 'COMPLETED') || [];
    const bonuses = wallet?.transactions.filter(t => t.type === 'BONUS' && t.status === 'COMPLETED') || [];
    const tips = wallet?.transactions.filter(t => t.type === 'TIP' && t.status === 'COMPLETED') || [];

    const todayEarnings = earnings.filter(t => t.createdAt >= startOfToday).reduce((s, t) => s + t.amount, 0);
    const weeklyEarnings = earnings.filter(t => t.createdAt >= startOfWeek).reduce((s, t) => s + t.amount, 0);
    const monthlyEarnings = earnings.filter(t => t.createdAt >= startOfMonth).reduce((s, t) => s + t.amount, 0);

    const todayDeliveries = earnings.filter(t => t.createdAt >= startOfToday).length;
    const totalDeliveries = earnings.length;

    const bonusEarnings = bonuses.reduce((s, t) => s + t.amount, 0);
    const tipEarnings = tips.reduce((s, t) => s + t.amount, 0);
    const onlineHours = await onlineHoursForWindow(req.driver.id, startOfToday, now);

    res.json({
      success: true,
      data: {
        todayEarnings,
        weeklyEarnings,
        monthlyEarnings,
        totalDeliveries,
        todayDeliveries,
        bonusEarnings,
        tipEarnings,
        onlineHours,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/driver/earnings/transactions
router.get('/transactions', async (req, res, next) => {
  try {
    const { limit, skip } = parsePagination(req.query);

    const wallet = await prisma.driverWallet.findUnique({
      where: { driverId: req.driver.id },
    });

    if (!wallet) {
      return res.json({ success: true, data: [] });
    }

    const transactions = await prisma.driverWalletTransaction.findMany({
      where: { walletId: wallet.id },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    });

    res.json({ success: true, data: transactions });
  } catch (err) {
    next(err);
  }
});

// GET /api/driver/wallet
router.get('/wallet', async (req, res, next) => {
  try {
    let wallet = await prisma.driverWallet.findUnique({
      where: { driverId: req.driver.id },
    });

    if (!wallet) {
      wallet = await prisma.driverWallet.create({ data: { driverId: req.driver.id } });
    }

    res.json({
      success: true,
      data: {
        balance: wallet.balance,
        pendingAmount: wallet.pendingAmount,
        lifetimeEarnings: wallet.lifetimeEarnings,
        lastPayout: null,
        lastPayoutDate: null,
        bankAccountLinked: !!req.driver.stripePayoutsEnabled,
        bankAccountLast4: req.driver.stripePayoutsEnabled ? 'Stripe' : null,
        stripeAccountId: req.driver.stripeConnectAccountId || null,
        stripeDetailsSubmitted: !!req.driver.stripeDetailsSubmitted,
        stripePayoutsEnabled: !!req.driver.stripePayoutsEnabled,
        stripeRequirements: req.driver.stripeRequirements || null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/driver/wallet/withdraw
router.post('/wallet/withdraw', async (req, res, next) => {
  try {
    res.status(410).json({
      success: false,
      message: 'Use /api/driver/payouts/withdraw for Stripe Connect withdrawals',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
