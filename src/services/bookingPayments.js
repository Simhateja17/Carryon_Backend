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

function isMissingStripeResource(err) {
  return err?.type === 'StripeInvalidRequestError' && err?.code === 'resource_missing';
}

async function createStripeCustomer(user, { persist = isStripeLiveMode() } = {}) {
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

  console.log(
    '[booking-payments] stripe_customer_created',
    'userId:', user.id,
    'customerId:', customer.id,
    'mode:', isStripeLiveMode() ? 'live' : 'test',
    'persisted:', persist
  );

  return customer.id;
}

async function ensureStripeCustomer(user) {
  if (user.stripeCustomerId) {
    try {
      await getStripe().customers.retrieve(user.stripeCustomerId);
      console.log(
        '[booking-payments] stripe_customer_reused',
        'userId:', user.id,
        'customerId:', user.stripeCustomerId,
        'mode:', isStripeLiveMode() ? 'live' : 'test'
      );
      return user.stripeCustomerId;
    } catch (err) {
      if (!isMissingStripeResource(err)) throw err;

      console.warn(
        '[booking-payments] ignoring missing or incompatible saved Stripe customer',
        user.stripeCustomerId,
        'currentMode:',
        isStripeLiveMode() ? 'live' : 'test'
      );
      return createStripeCustomer(user);
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

  console.log(
    '[booking-payments] payment_intent_created',
    'bookingId:', booking.id,
    'orderCode:', booking.orderCode || '',
    'userId:', user.id,
    'paymentIntentId:', paymentIntent.id,
    'amountMinor:', amountMinor,
    'currency:', currency,
    'customerId:', customer,
    'mode:', isStripeLiveMode() ? 'live' : 'test',
    'bookingPaymentId:', payment.id
  );

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
        console.log(
          '[booking-payments] payment_intent_reused',
          'bookingId:', booking.id,
          'paymentIntentId:', latestPayment.stripePaymentIntentId,
          'stripeStatus:', paymentIntent.status,
          'bookingPaymentId:', latestPayment.id
        );
        return bookingPaymentPayload(latestPayment, paymentIntent);
      }
      console.log(
        '[booking-payments] payment_intent_not_reused',
        'bookingId:', booking.id,
        'paymentIntentId:', latestPayment.stripePaymentIntentId,
        'stripeStatus:', paymentIntent.status,
        'bookingPaymentId:', latestPayment.id
      );
    } catch (err) {
      if (!isMissingStripeResource(err)) throw err;
      console.warn(
        '[booking-payments] ignoring missing or incompatible pending PaymentIntent',
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
  if (!payment) {
    console.warn(
      '[booking-payments] payment_succeeded_unknown_intent',
      'paymentIntentId:', paymentIntent.id
    );
    return [];
  }

  const now = new Date();
  console.log(
    '[booking-payments] payment_succeeded_webhook',
    'bookingId:', payment.bookingId,
    'bookingPaymentId:', payment.id,
    'paymentIntentId:', paymentIntent.id,
    'amount:', payment.amount,
    'priorPaymentStatus:', payment.status,
    'bookingStatus:', payment.booking?.status,
    'bookingPaymentStatus:', payment.booking?.paymentStatus
  );

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

  console.log(
    '[booking-payments] booking_payment_completed',
    'bookingId:', payment.bookingId,
    'paymentIntentId:', paymentIntent.id,
    'advancedToDispatch:', updateResult.count === 1,
    'updateCount:', updateResult.count
  );

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
  if (!payment) {
    console.warn(
      '[booking-payments] payment_failed_unknown_intent',
      'paymentIntentId:', paymentIntent.id,
      'status:', status
    );
    return [];
  }
  if (payment.status === 'COMPLETED') {
    console.log(
      '[booking-payments] payment_failure_ignored_completed_payment',
      'bookingId:', payment.bookingId,
      'bookingPaymentId:', payment.id,
      'paymentIntentId:', paymentIntent.id,
      'incomingStatus:', status
    );
    return [];
  }

  console.log(
    '[booking-payments] payment_failed_webhook',
    'bookingId:', payment.bookingId,
    'bookingPaymentId:', payment.id,
    'paymentIntentId:', paymentIntent.id,
    'status:', status,
    'failureMessage:', failureMessage || ''
  );

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
  if (refundMinor <= 0) {
    console.log(
      '[booking-payments] refund_skipped_nothing_refundable',
      'bookingId:', booking.id,
      'bookingPaymentId:', payment.id,
      'requestedRefundAmount:', refundAmount,
      'alreadyRefundedAmount:', payment.refundedAmount || 0,
      'paymentAmount:', payment.amount
    );
    return null;
  }

  try {
    console.log(
      '[booking-payments] refund_create_started',
      'bookingId:', booking.id,
      'bookingPaymentId:', payment.id,
      'paymentIntentId:', payment.stripePaymentIntentId,
      'refundMinor:', refundMinor,
      'currency:', payment.currency,
      'reason:', reason
    );

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

    console.log(
      '[booking-payments] refund_completed',
      'bookingId:', booking.id,
      'bookingPaymentId:', payment.id,
      'paymentIntentId:', payment.stripePaymentIntentId,
      'refundId:', refund.id,
      'refundedAmount:', refundedAmount
    );

    return refund;
  } catch (err) {
    console.error(
      '[booking-payments] refund_failed',
      'bookingId:', booking.id,
      'bookingPaymentId:', payment.id,
      'paymentIntentId:', payment.stripePaymentIntentId,
      'message:', err.message || String(err)
    );
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
