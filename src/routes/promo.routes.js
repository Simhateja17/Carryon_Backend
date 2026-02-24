const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticate } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');

const router = Router();
router.use(authenticate);

// POST /api/promo/validate - Validate a promo code
router.post('/validate', async (req, res, next) => {
  try {
    const { code, orderAmount } = req.body;
    if (!code) return next(new AppError('Promo code is required', 400));

    const coupon = await prisma.coupon.findUnique({ where: { code: code.toUpperCase() } });
    if (!coupon) return next(new AppError('Invalid promo code', 404));
    if (!coupon.isActive) return next(new AppError('This promo code is no longer active', 400));
    if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) {
      return next(new AppError('This promo code has expired', 400));
    }
    if (coupon.usedCount >= coupon.usageLimit) {
      return next(new AppError('This promo code has reached its usage limit', 400));
    }
    if (orderAmount && orderAmount < coupon.minOrderValue) {
      return next(new AppError(`Minimum order value is RM ${coupon.minOrderValue}`, 400));
    }

    // Check if user already used this coupon
    const existing = await prisma.userCoupon.findUnique({
      where: { userId_couponId: { userId: req.user.userId, couponId: coupon.id } },
    });
    if (existing && existing.usedAt) {
      return next(new AppError('You have already used this promo code', 400));
    }

    let discount = 0;
    if (coupon.discountType === 'PERCENTAGE') {
      discount = ((orderAmount || 0) * coupon.discountValue) / 100;
      if (coupon.maxDiscount && discount > coupon.maxDiscount) {
        discount = coupon.maxDiscount;
      }
    } else {
      discount = coupon.discountValue;
    }

    res.json({
      success: true,
      data: {
        couponId: coupon.id,
        code: coupon.code,
        description: coupon.description,
        discountType: coupon.discountType,
        discountValue: coupon.discountValue,
        calculatedDiscount: Math.round(discount * 100) / 100,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/promo/apply - Apply a promo code to a booking
router.post('/apply', async (req, res, next) => {
  try {
    const { code, bookingId } = req.body;
    if (!code || !bookingId) return next(new AppError('Code and bookingId are required', 400));

    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking || booking.userId !== req.user.userId) {
      return next(new AppError('Booking not found', 404));
    }

    const coupon = await prisma.coupon.findUnique({ where: { code: code.toUpperCase() } });
    if (!coupon || !coupon.isActive) return next(new AppError('Invalid promo code', 400));

    let discount = 0;
    if (coupon.discountType === 'PERCENTAGE') {
      discount = (booking.estimatedPrice * coupon.discountValue) / 100;
      if (coupon.maxDiscount && discount > coupon.maxDiscount) discount = coupon.maxDiscount;
    } else {
      discount = coupon.discountValue;
    }
    discount = Math.round(discount * 100) / 100;

    const [updatedBooking] = await prisma.$transaction([
      prisma.booking.update({
        where: { id: bookingId },
        data: { promoCode: coupon.code, discountAmount: discount },
      }),
      prisma.coupon.update({
        where: { id: coupon.id },
        data: { usedCount: { increment: 1 } },
      }),
      prisma.userCoupon.upsert({
        where: { userId_couponId: { userId: req.user.userId, couponId: coupon.id } },
        create: { userId: req.user.userId, couponId: coupon.id, bookingId, usedAt: new Date() },
        update: { bookingId, usedAt: new Date() },
      }),
    ]);

    res.json({ success: true, data: { discount, finalPrice: booking.estimatedPrice - discount } });
  } catch (err) {
    next(err);
  }
});

// GET /api/promo/coupons - List available coupons for user
router.get('/coupons', async (req, res, next) => {
  try {
    const coupons = await prisma.coupon.findMany({
      where: {
        isActive: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: 'desc' },
    });

    const usedCoupons = await prisma.userCoupon.findMany({
      where: { userId: req.user.userId, usedAt: { not: null } },
      select: { couponId: true },
    });
    const usedIds = new Set(usedCoupons.map((uc) => uc.couponId));

    const available = coupons
      .filter((c) => !usedIds.has(c.id) && c.usedCount < c.usageLimit)
      .map((c) => ({
        id: c.id,
        code: c.code,
        description: c.description,
        discountType: c.discountType,
        discountValue: c.discountValue,
        maxDiscount: c.maxDiscount,
        minOrderValue: c.minOrderValue,
        expiresAt: c.expiresAt,
      }));

    res.json({ success: true, data: available });
  } catch (err) {
    next(err);
  }
});

// GET /api/promo/referral - Get user's referral code & stats
router.get('/referral', async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { referralCode: true, name: true },
    });

    const referrals = await prisma.referral.findMany({
      where: { referrerId: req.user.userId },
    });
    const completedCount = referrals.filter((r) => r.status === 'COMPLETED').length;
    const totalEarned = referrals
      .filter((r) => r.status === 'COMPLETED')
      .reduce((sum, r) => sum + r.rewardAmount, 0);

    res.json({
      success: true,
      data: {
        referralCode: user.referralCode,
        totalReferrals: referrals.length,
        completedReferrals: completedCount,
        totalEarned,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/promo/referral/apply - Apply a referral code (for new users)
router.post('/referral/apply', async (req, res, next) => {
  try {
    const { referralCode } = req.body;
    if (!referralCode) return next(new AppError('Referral code is required', 400));

    const referrer = await prisma.user.findUnique({ where: { referralCode } });
    if (!referrer) return next(new AppError('Invalid referral code', 404));
    if (referrer.id === req.user.userId) {
      return next(new AppError('You cannot use your own referral code', 400));
    }

    // Check if user already used a referral
    const existing = await prisma.referral.findFirst({
      where: { refereeId: req.user.userId },
    });
    if (existing) return next(new AppError('You have already used a referral code', 400));

    const rewardAmount = 5.0; // RM 5

    await prisma.$transaction(async (tx) => {
      // Create referral record
      await tx.referral.create({
        data: {
          referrerId: referrer.id,
          refereeId: req.user.userId,
          referralCode,
          rewardAmount,
          status: 'COMPLETED',
        },
      });

      // Credit both wallets
      for (const userId of [referrer.id, req.user.userId]) {
        const wallet = await tx.wallet.upsert({
          where: { userId },
          create: { userId, balance: rewardAmount },
          update: { balance: { increment: rewardAmount } },
        });
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            type: 'REFERRAL_BONUS',
            amount: rewardAmount,
            description: 'Referral bonus',
          },
        });
      }
    });

    res.json({ success: true, message: `RM ${rewardAmount} credited to your wallet!` });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
