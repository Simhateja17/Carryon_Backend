const { Router } = require('express');
const prisma = require('../lib/prisma');
const { DRIVER_COMMISSION_RATE } = require('../services/businessConfig');
const { driverEarningFromGross } = require('../lib/money');
const { parsePagination } = require('../lib/pagination');
const { AppError } = require('../middleware/errorHandler');

const router = Router();

// ── Helpers ────────────────────────────────────────────────

// Malaysia timezone offset (+08:00) for consistent date grouping
const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;
function toMYTDateKey(date) {
  const myt = new Date(date.getTime() + MYT_OFFSET_MS);
  return myt.toISOString().slice(0, 10);
}

function dateWindowFromPeriod(period) {
  const now = new Date();
  if (period === 'monthly') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return { start, end: now };
  }
  // default: weekly (last 7 days)
  const start = new Date(now);
  start.setDate(start.getDate() - 6);
  start.setHours(0, 0, 0, 0);
  return { start, end: now };
}

// ── GET /api/admin/revenue/stats ───────────────────────────
// Query: ?period=weekly|monthly
router.get('/stats', async (req, res, next) => {
  try {
    const period = req.query.period === 'monthly' ? 'monthly' : 'weekly';
    const { start, end } = dateWindowFromPeriod(period);

    const [bookingAgg, commissionAgg] = await Promise.all([
      prisma.booking.aggregate({
        where: {
          status: 'DELIVERED',
          createdAt: { gte: start, lte: end },
        },
        _sum: { finalPrice: true },
        _count: { id: true },
      }),
      prisma.driverWalletTransaction.aggregate({
        where: {
          type: 'DELIVERY_EARNING',
          createdAt: { gte: start, lte: end },
        },
        _sum: { platformFeeAmount: true },
      }),
    ]);

    const totalRevenue = bookingAgg._sum.finalPrice || 0;
    const totalCommission = commissionAgg._sum.platformFeeAmount || 0;
    const orderCount = bookingAgg._count.id || 0;
    const avgCommissionPerOrder = orderCount > 0 ? totalCommission / orderCount : 0;

    res.json({
      success: true,
      data: {
        totalRevenue,
        totalCommission,
        avgCommissionPerOrder,
        orderCount,
        period,
        startDate: start.toISOString(),
        endDate: end.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/revenue/chart ───────────────────────────
// Query: ?period=weekly|monthly
router.get('/chart', async (req, res, next) => {
  try {
    const period = req.query.period === 'monthly' ? 'monthly' : 'weekly';
    const { start, end } = dateWindowFromPeriod(period);

    const bookings = await prisma.booking.findMany({
      where: {
        status: 'DELIVERED',
        createdAt: { gte: start, lte: end },
      },
      select: { finalPrice: true, createdAt: true },
    });

    // Group by Malaysia date (UTC+8)
    const byDate = {};
    for (const b of bookings) {
      const key = toMYTDateKey(b.createdAt);
      byDate[key] = (byDate[key] || 0) + (b.finalPrice || 0);
    }

    // Build complete date series using MYT dates
    const points = [];
    const cursor = new Date(start);
    cursor.setHours(0, 0, 0, 0);
    const endDate = new Date(end);
    endDate.setHours(23, 59, 59, 999);
    while (cursor <= endDate) {
      const key = toMYTDateKey(cursor);
      points.push({ date: key, revenue: byDate[key] || 0 });
      cursor.setDate(cursor.getDate() + 1);
    }

    res.json({ success: true, data: points });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/revenue/transactions ────────────────────
// Query: ?page, ?limit, ?status, ?paymentMethod, ?dateFrom, ?dateTo, ?minAmount, ?maxAmount
router.get('/transactions', async (req, res, next) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);

    const where = { status: 'DELIVERED' };

    const VALID_PAYMENT_METHODS = ['CASH', 'UPI', 'CARD', 'WALLET'];
    const VALID_PAYMENT_STATUSES = ['COMPLETED', 'PENDING', 'FAILED', 'REFUNDED'];

    if (req.query.paymentMethod && req.query.paymentMethod !== 'all') {
      const method = String(req.query.paymentMethod).toUpperCase();
      if (!VALID_PAYMENT_METHODS.includes(method)) {
        return next(new AppError(`Invalid paymentMethod. Must be one of: ${VALID_PAYMENT_METHODS.join(', ')}`, 400));
      }
      where.paymentMethod = method;
    }

    if (req.query.status && req.query.status !== 'all') {
      const ps = String(req.query.status).toUpperCase();
      if (!VALID_PAYMENT_STATUSES.includes(ps)) {
        return next(new AppError(`Invalid status. Must be one of: ${VALID_PAYMENT_STATUSES.join(', ')}`, 400));
      }
      where.paymentStatus = ps;
    }

    if (req.query.dateFrom || req.query.dateTo) {
      where.createdAt = {};
      if (req.query.dateFrom) {
        const from = new Date(req.query.dateFrom);
        if (isNaN(from.getTime())) return next(new AppError('Invalid dateFrom format', 400));
        where.createdAt.gte = from;
      }
      if (req.query.dateTo) {
        const to = new Date(req.query.dateTo);
        if (isNaN(to.getTime())) return next(new AppError('Invalid dateTo format', 400));
        where.createdAt.lte = to;
      }
    }

    if (req.query.minAmount || req.query.maxAmount) {
      where.finalPrice = {};
      if (req.query.minAmount) {
        const min = parseFloat(req.query.minAmount);
        if (!Number.isFinite(min)) return next(new AppError('Invalid minAmount: must be a number', 400));
        where.finalPrice.gte = min;
      }
      if (req.query.maxAmount) {
        const max = parseFloat(req.query.maxAmount);
        if (!Number.isFinite(max)) return next(new AppError('Invalid maxAmount: must be a number', 400));
        where.finalPrice.lte = max;
      }
    }

    const [total, bookings] = await Promise.all([
      prisma.booking.count({ where }),
      prisma.booking.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          orderCode: true,
          finalPrice: true,
          paymentMethod: true,
          paymentStatus: true,
          createdAt: true,
          user: { select: { id: true, name: true, email: true } },
        },
      }),
    ]);

    res.json({
      success: true,
      data: bookings.map((b) => ({
        id: b.id,
        orderCode: b.orderCode,
        customerName: b.user?.name || 'Unknown',
        customerEmail: b.user?.email || '',
        amount: b.finalPrice,
        paymentMethod: b.paymentMethod,
        paymentStatus: b.paymentStatus,
        createdAt: b.createdAt,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/revenue/transactions/:id ────────────────
router.get('/transactions/:id', async (req, res, next) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: {
        user: { select: { id: true, name: true, email: true, phone: true } },
        driver: { select: { id: true, name: true, phone: true } },
        pickupAddress: { select: { address: true } },
        deliveryAddress: { select: { address: true } },
        lifecycleEvents: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            command: true,
            fromStatus: true,
            toStatus: true,
            success: true,
            createdAt: true,
          },
        },
      },
    });

    if (!booking) return next(new AppError('Booking not found', 404));

    // Compute fee breakdown using the canonical money helper
    const gross = booking.finalPrice || booking.estimatedPrice || 0;
    const breakdown = driverEarningFromGross(gross);
    const driverShare = breakdown.driverAmount;
    const platformFee = breakdown.platformFeeAmount;

    res.json({
      success: true,
      data: {
        id: booking.id,
        orderCode: booking.orderCode,
        status: booking.status,
        paymentMethod: booking.paymentMethod,
        paymentStatus: booking.paymentStatus,
        createdAt: booking.createdAt,
        deliveredAt: booking.deliveredAt,
        customer: {
          name: booking.user?.name || 'Unknown',
          email: booking.user?.email || '',
          phone: booking.user?.phone || '',
        },
        driver: booking.driver ? {
          name: booking.driver.name,
          phone: booking.driver.phone,
        } : null,
        pickup: booking.pickupAddress?.address || '',
        delivery: booking.deliveryAddress?.address || '',
        feeBreakdown: {
          grossAmount: gross,
          distance: booking.distance,
          waitTimeCharge: booking.waitTimeCharge,
          discountAmount: booking.discountAmount,
          platformCommission: platformFee,
          platformCommissionRate: Math.round((1 - DRIVER_COMMISSION_RATE) * 100),
          driverPayout: driverShare,
        },
        timeline: booking.lifecycleEvents
          .filter((e) => e.success)
          .map((e) => ({
            command: e.command,
            fromStatus: e.fromStatus,
            toStatus: e.toStatus,
            createdAt: e.createdAt,
          })),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/revenue/driver-earnings ─────────────────
// Query: ?page, ?limit, ?dateFrom, ?dateTo
router.get('/driver-earnings', async (req, res, next) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);

    const where = { type: 'DELIVERY_EARNING' };

    if (req.query.dateFrom || req.query.dateTo) {
      where.createdAt = {};
      if (req.query.dateFrom) {
        const from = new Date(req.query.dateFrom);
        if (!isNaN(from.getTime())) where.createdAt.gte = from;
      }
      if (req.query.dateTo) {
        const to = new Date(req.query.dateTo);
        if (!isNaN(to.getTime())) where.createdAt.lte = to;
      }
    }

    const [total, transactions] = await Promise.all([
      prisma.driverWalletTransaction.count({ where }),
      prisma.driverWalletTransaction.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          wallet: {
            include: {
              driver: { select: { id: true, name: true, phone: true } },
            },
          },
        },
      }),
    ]);

    res.json({
      success: true,
      data: transactions.map((t) => ({
        id: t.id,
        driverName: t.wallet?.driver?.name || 'Unknown',
        driverId: t.wallet?.driver?.id || '',
        bookingId: t.jobId,
        grossAmount: t.grossAmount,
        platformFee: t.platformFeeAmount,
        driverEarning: t.amount,
        createdAt: t.createdAt,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/revenue/refunds ─────────────────────────
// Query: ?page, ?limit, ?dateFrom, ?dateTo
router.get('/refunds', async (req, res, next) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);

    const where = { type: 'REFUND' };

    if (req.query.dateFrom || req.query.dateTo) {
      where.createdAt = {};
      if (req.query.dateFrom) {
        const from = new Date(req.query.dateFrom);
        if (!isNaN(from.getTime())) where.createdAt.gte = from;
      }
      if (req.query.dateTo) {
        const to = new Date(req.query.dateTo);
        if (!isNaN(to.getTime())) where.createdAt.lte = to;
      }
    }

    const [total, transactions] = await Promise.all([
      prisma.walletTransaction.count({ where }),
      prisma.walletTransaction.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          wallet: {
            include: {
              user: { select: { id: true, name: true, email: true } },
            },
          },
        },
      }),
    ]);

    // Batch-fetch booking order codes instead of N+1
    const referenceIds = transactions.map((t) => t.referenceId).filter(Boolean);
    const bookings = referenceIds.length > 0
      ? await prisma.booking.findMany({
          where: { id: { in: referenceIds } },
          select: { id: true, orderCode: true },
        })
      : [];
    const orderCodeMap = new Map(bookings.map((b) => [b.id, b.orderCode]));

    const enriched = transactions.map((t) => ({
      id: t.id,
      customerName: t.wallet?.user?.name || 'Unknown',
      customerEmail: t.wallet?.user?.email || '',
      bookingId: t.referenceId,
      orderCode: orderCodeMap.get(t.referenceId) || null,
      amount: t.amount,
      description: t.description,
      createdAt: t.createdAt,
    }));

    res.json({
      success: true,
      data: enriched,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/revenue/issues ──────────────────────────
router.get('/issues', async (req, res, next) => {
  try {
    const [failedBookings, failedPayouts, totalDelivered, refundedCount] = await Promise.all([
      prisma.booking.groupBy({
        by: ['paymentMethod'],
        where: { paymentStatus: 'FAILED' },
        _count: { id: true },
      }),
      prisma.driverPayout.count({ where: { status: 'FAILED' } }),
      prisma.booking.count({ where: { status: 'DELIVERED' } }),
      prisma.booking.count({ where: { paymentStatus: 'REFUNDED' } }),
    ]);

    const totalFailed = failedBookings.reduce((sum, g) => sum + g._count.id, 0);
    const successRate = totalDelivered > 0
      ? ((totalDelivered - totalFailed - refundedCount) / totalDelivered * 100).toFixed(1)
      : '0.0';
    const refundRate = totalDelivered > 0
      ? (refundedCount / totalDelivered * 100).toFixed(1)
      : '0.0';

    res.json({
      success: true,
      data: {
        failedByMethod: failedBookings.map((g) => ({
          paymentMethod: g.paymentMethod,
          count: g._count.id,
        })),
        failedPayouts,
        successRate: parseFloat(successRate),
        refundRate: parseFloat(refundRate),
        totalDelivered,
        totalFailed,
        totalRefunded: refundedCount,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
