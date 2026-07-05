const prisma = require('../lib/prisma');
const { getStripe, isStripeLiveMode, stripeCurrency } = require('../lib/stripe');
const { fromMinorUnits, money, toMinorUnits } = require('../lib/money');
const { recordAudit } = require('./auditLog');

const BOOKING_PAYMENT_PURPOSE = 'booking_payment';
const PENDING_BOOKING_PAYMENT_TTL_MS = Number(process.env.BOOKING_PAYMENT_TTL_MS || 15 * 60 * 1000);

function paymentExpiresAt(createdAt = new Date()) {
  return new Date(new Date(createdAt).getTime() + PENDING_BOOKING_PAYMENT_TTL_MS);
}

function isPendingPaymentFresh(payment, now = new Date()) {
  return payment?.status === 'PENDING' && paymentExpiresAt(payment.createdAt).getTime() > now.getTime();
}

function isStripeModeMismatch(err) {
  return err?.type === 'StripeInvalidRequestError'
    && err?.code === 'resource_missing'
    && typeof err?.message === 'string'
    && err.message.includes('a similar object exists in')
    && err.message.includes('mode');
}

async function createStripeCustomer(user, { persist = true } = {}) {
  const customer = await getStripe().customers.create({
    email: user.email,
    name: user.name || undefined,
    phone: user.phone || undefined,
    metadata: { userId: user.id },
  });

  if (persist) {
    await prisma.user.update({
      where: { id: user.id },
      data: { stripeCustomerId: customer.id },
    });
  }

  return customer.id;
}

async function ensureStripeCustomer(user) {
  if (user.stripeCustomerId) {
    try {
      await getStripe().customers.retrieve(user.stripeCustomerId);
      return user.stripeCustomerId;
    } catch (err) {
      if (!isStripeModeMismatch(err)) throw err;

      console.warn(
        '[booking-payments] ignoring saved Stripe customer from different mode',
        user.stripeCustomerId,
        'currentMode:',
        isStripeLiveMode() ? 'live' : 'test'
      );
      return createStripeCustomer(user, { persist: false });
    }
  }

  return createStripeCustomer(user);
}

function bookingPaymentPayload(payment, paymentIntent) {
  return {
    paymentIntentId: payment.stripePaymentIntentId,
    clientSecret: paymentIntent.client_secret,
    amount: payment.amount,
    currency: payment.currency,
    expiresAt: paymentExpiresAt(payment.createdAt).toISOString(),
  };
}

async function createBookingPaymentIntent({ booking, user }) {
  const amountMinor = toMinorUnits(booking.finalPrice || booking.estimatedPrice || 0);
  if (!amountMinor || amountMinor <= 0) {
    const err = new Error('Booking payment amount must be greater than zero');
    err.statusCode = 400;
    throw err;
  }

  const currency = stripeCurrency();
  const customer = await ensureStripeCustomer(user);
  const stripe = getStripe();
  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountMinor,
    currency,
    customer,
    automatic_payment_methods: { enabled: true },
    metadata: {
      purpose: BOOKING_PAYMENT_PURPOSE,
      bookingId: booking.id,
      userId: user.id,
      orderCode: booking.orderCode || '',
    },
  });

  const payment = await prisma.bookingPayment.create({
    data: {
      bookingId: booking.id,
      userId: user.id,
      amount: fromMinorUnits(amountMinor),
      amountMinor,
      currency,
      status: 'PENDING',
      stripePaymentIntentId: paymentIntent.id,
    },
  });

  await prisma.booking.update({
    where: { id: booking.id },
    data: { paymentStatus: 'PENDING', paymentMethod: 'STRIPE' },
  });

  return bookingPaymentPayload(payment, paymentIntent);
}

async function createOrReuseBookingPaymentIntent({ booking, user, now = new Date() }) {
  const latestPayment = await prisma.bookingPayment.findFirst({
    where: { bookingId: booking.id },
    orderBy: { createdAt: 'desc' },
  });

  if (isPendingPaymentFresh(latestPayment, now)) {
    try {
      const paymentIntent = await getStripe().paymentIntents.retrieve(latestPayment.stripePaymentIntentId);
      if (!['canceled', 'succeeded'].includes(paymentIntent.status)) {
        return bookingPaymentPayload(latestPayment, paymentIntent);
      }
    } catch (err) {
      if (!isStripeModeMismatch(err)) throw err;
      console.warn(
        '[booking-payments] ignoring pending PaymentIntent from different Stripe mode',
        latestPayment.stripePaymentIntentId,
        'currentMode:',
        isStripeLiveMode() ? 'live' : 'test'
      );
    }
  }

  return createBookingPaymentIntent({ booking, user });
}

async function markBookingPaymentSucceededTx(tx, paymentIntent) {
  const payment = await tx.bookingPayment.findUnique({
    where: { stripePaymentIntentId: paymentIntent.id },
    include: { booking: { include: { pickupAddress: true, deliveryAddress: true, driver: true } } },
  });
  if (!payment) return [];

  const now = new Date();
  await tx.bookingPayment.update({
    where: { id: payment.id },
    data: {
      status: 'COMPLETED',
      failureMessage: null,
      paidAt: payment.paidAt || now,
    },
  });

  const updateResult = await tx.booking.updateMany({
    where: {
      id: payment.bookingId,
      status: 'PENDING',
      paymentStatus: { not: 'COMPLETED' },
    },
    data: {
      status: 'SEARCHING_DRIVER',
      paymentMethod: 'STRIPE',
      paymentStatus: 'COMPLETED',
      finalPrice: money(payment.amount),
    },
  });

  await recordAudit(tx, {
    actor: { actorId: payment.userId, actorType: 'USER' },
    action: 'BOOKING_PAYMENT_COMPLETED',
    entityType: 'Booking',
    entityId: payment.bookingId,
    newValue: {
      stripePaymentIntentId: paymentIntent.id,
      amount: payment.amount,
      statusAdvancedToDispatch: updateResult.count === 1,
    },
  });

  return updateResult.count === 1 ? [{ type: 'DISPATCH_BOOKING', bookingId: payment.bookingId }] : [];
}

async function markBookingPaymentFailedTx(tx, paymentIntent, status, failureMessage = null) {
  const payment = await tx.bookingPayment.findUnique({
    where: { stripePaymentIntentId: paymentIntent.id },
  });
  if (!payment || payment.status === 'COMPLETED') return [];

  await tx.bookingPayment.update({
    where: { id: payment.id },
    data: {
      status,
      failureMessage,
    },
  });

  await tx.booking.updateMany({
    where: {
      id: payment.bookingId,
      status: 'PENDING',
      paymentStatus: { not: 'COMPLETED' },
    },
    data: { paymentStatus: 'FAILED' },
  });

  return [];
}

async function refundLatestBookingPayment({ booking, amount, reason = 'Booking cancellation refund' }) {
  const refundAmount = money(amount);
  if (!Number.isFinite(refundAmount) || refundAmount <= 0) return null;

  const payment = await prisma.bookingPayment.findFirst({
    where: {
      bookingId: booking.id,
      status: 'COMPLETED',
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!payment) {
    const err = new Error('No completed Stripe payment found for booking refund');
    err.statusCode = 409;
    throw err;
  }

  const remainingRefundable = money(payment.amount - (payment.refundedAmount || 0));
  const refundMinor = Math.min(toMinorUnits(refundAmount), toMinorUnits(remainingRefundable));
  if (refundMinor <= 0) return null;

  try {
    const refund = await getStripe().refunds.create({
      payment_intent: payment.stripePaymentIntentId,
      amount: refundMinor,
      reason: 'requested_by_customer',
      metadata: {
        bookingId: booking.id,
        bookingPaymentId: payment.id,
        reason,
      },
    });

    const refundedAmount = money((payment.refundedAmount || 0) + fromMinorUnits(refundMinor));
    await prisma.$transaction(async (tx) => {
      await tx.bookingPayment.update({
        where: { id: payment.id },
        data: {
          stripeRefundId: refund.id,
          refundedAmount,
          refundStatus: 'COMPLETED',
          failureMessage: null,
          refundedAt: new Date(),
        },
      });
      await tx.booking.update({
        where: { id: booking.id },
        data: { paymentStatus: 'REFUNDED' },
      });
    });

    return refund;
  } catch (err) {
    await prisma.bookingPayment.update({
      where: { id: payment.id },
      data: {
        refundStatus: 'FAILED',
        failureMessage: err.message || 'Stripe refund failed',
      },
    });
    throw err;
  }
}

async function expirePendingBookingPayments({ now = new Date(), limit = 50 } = {}) {
  const cutoff = new Date(now.getTime() - PENDING_BOOKING_PAYMENT_TTL_MS);
  const stalePayments = await prisma.bookingPayment.findMany({
    where: {
      status: 'PENDING',
      createdAt: { lte: cutoff },
      booking: {
        status: 'PENDING',
        paymentStatus: { not: 'COMPLETED' },
      },
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
    include: { booking: true },
  });

  const expired = [];
  for (const payment of stalePayments) {
    const latestPending = await prisma.bookingPayment.findFirst({
      where: { bookingId: payment.bookingId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
    if (latestPending?.id !== payment.id) continue;

    try {
      await getStripe().paymentIntents.cancel(payment.stripePaymentIntentId);
    } catch (err) {
      console.warn('[booking-payments] failed to cancel stale PaymentIntent', payment.stripePaymentIntentId, err.message);
    }

    await prisma.$transaction(async (tx) => {
      await tx.bookingPayment.update({
        where: { id: payment.id },
        data: {
          status: 'CANCELED',
          failureMessage: 'Payment expired before completion',
        },
      });
      await tx.booking.updateMany({
        where: {
          id: payment.bookingId,
          status: 'PENDING',
          paymentStatus: { not: 'COMPLETED' },
        },
        data: {
          status: 'CANCELLED',
          cancelledBy: 'SYSTEM',
          cancelReason: 'Payment expired before completion',
          paymentStatus: 'FAILED',
        },
      });
    });
    expired.push(payment.id);
  }

  return expired;
}

function startPendingBookingPaymentExpiryLoop({ intervalMs = 60_000 } = {}) {
  const timer = setInterval(() => {
    expirePendingBookingPayments().catch((err) => {
      console.error('[booking-payments] expiry loop failed:', err);
    });
  }, intervalMs);
  timer.unref?.();
  return timer;
}

module.exports = {
  BOOKING_PAYMENT_PURPOSE,
  PENDING_BOOKING_PAYMENT_TTL_MS,
  createOrReuseBookingPaymentIntent,
  expirePendingBookingPayments,
  markBookingPaymentFailedTx,
  markBookingPaymentSucceededTx,
  refundLatestBookingPayment,
  startPendingBookingPaymentExpiryLoop,
};
