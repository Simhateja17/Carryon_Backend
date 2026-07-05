const prisma = require('../lib/prisma');
const { handleStripeEvent } = require('./stripeWebhookProcessor');
const { notifyNearbyDrivers } = require('./dispatch');

const MAX_ATTEMPTS = 4;

function nextAttemptAt(retryCount, now = new Date()) {
  const delayMinutes = Math.pow(2, Math.max(0, retryCount - 1));
  return new Date(now.getTime() + delayMinutes * 60 * 1000);
}

async function recordStripeEvent(event) {
  return prisma.webhookEvent.upsert({
    where: {
      provider_providerEventId: {
        provider: 'stripe',
        providerEventId: event.id,
      },
    },
    create: {
      provider: 'stripe',
      providerEventId: event.id,
      eventType: event.type,
      payload: event,
      status: 'PENDING',
      nextAttemptAt: new Date(),
    },
    update: {},
  });
}

async function processWebhookEvent(eventRecord) {
  console.log(
    '[webhook-inbox] processing_started',
    'eventRecordId:', eventRecord.id,
    'providerEventId:', eventRecord.providerEventId,
    'eventType:', eventRecord.eventType,
    'status:', eventRecord.status,
    'retryCount:', eventRecord.retryCount || 0
  );

  if (eventRecord.status === 'PROCESSED' || eventRecord.status === 'FAILED') {
    console.log(
      '[webhook-inbox] processing_skipped_terminal',
      'eventRecordId:', eventRecord.id,
      'providerEventId:', eventRecord.providerEventId,
      'status:', eventRecord.status
    );
    return eventRecord;
  }

  let postCommitTasks = [];
  try {
    const processedEvent = await prisma.$transaction(async (tx) => {
      const current = await tx.webhookEvent.findUnique({ where: { id: eventRecord.id } });
      if (!current || current.status === 'PROCESSED' || current.status === 'FAILED') return current;

      await tx.webhookEvent.update({
        where: { id: current.id },
        data: { status: 'PROCESSING', lastError: null },
      });

      if (current.provider === 'stripe') {
        const tasks = await handleStripeEvent(tx, current.payload);
        postCommitTasks = Array.isArray(tasks) ? tasks : [];
        console.log(
          '[webhook-inbox] stripe_event_handled',
          'eventRecordId:', current.id,
          'providerEventId:', current.providerEventId,
          'eventType:', current.eventType,
          'postCommitTasks:', postCommitTasks.map((task) => task?.type).join(',') || 'none'
        );
      }

      return tx.webhookEvent.update({
        where: { id: current.id },
        data: {
          status: 'PROCESSED',
          processedAt: new Date(),
          nextAttemptAt: null,
          lastError: null,
        },
      });
    });

    await runPostCommitTasks(postCommitTasks);
    console.log(
      '[webhook-inbox] processing_completed',
      'eventRecordId:', processedEvent?.id,
      'providerEventId:', processedEvent?.providerEventId,
      'eventType:', processedEvent?.eventType,
      'status:', processedEvent?.status
    );
    return processedEvent;
  } catch (err) {
    const retryCount = (eventRecord.retryCount || 0) + 1;
    const failed = retryCount >= MAX_ATTEMPTS;
    console.error(
      '[webhook-inbox] processing_failed',
      'eventRecordId:', eventRecord.id,
      'providerEventId:', eventRecord.providerEventId,
      'eventType:', eventRecord.eventType,
      'retryCount:', retryCount,
      'terminal:', failed,
      'message:', err.message || String(err)
    );
    return prisma.webhookEvent.update({
      where: { id: eventRecord.id },
      data: {
        status: failed ? 'FAILED' : 'RETRYING',
        retryCount,
        lastError: err.message || String(err),
        nextAttemptAt: failed ? null : nextAttemptAt(retryCount),
      },
    });
  }
}

async function runPostCommitTasks(tasks) {
  for (const task of tasks || []) {
    if (task?.type !== 'DISPATCH_BOOKING' || !task.bookingId) continue;
    console.log(
      '[webhook-inbox] dispatch_task_started',
      'bookingId:', task.bookingId
    );
    const booking = await prisma.booking.findUnique({
      where: { id: task.bookingId },
      include: { pickupAddress: true, deliveryAddress: true, driver: true },
    });
    if (!booking || booking.status !== 'SEARCHING_DRIVER' || booking.paymentStatus !== 'COMPLETED') {
      console.warn(
        '[webhook-inbox] dispatch_task_skipped',
        'bookingId:', task.bookingId,
        'found:', !!booking,
        'bookingStatus:', booking?.status || '',
        'paymentStatus:', booking?.paymentStatus || ''
      );
      continue;
    }
    notifyNearbyDrivers(booking).catch((err) => {
      console.error('[webhook-inbox] post-payment dispatch failed:', err.message);
    });
    console.log(
      '[webhook-inbox] dispatch_task_enqueued',
      'bookingId:', booking.id,
      'orderCode:', booking.orderCode || ''
    );
  }
}

async function processDueWebhookEvents({ now = new Date(), limit = 25 } = {}) {
  const dueEvents = await prisma.webhookEvent.findMany({
    where: {
      status: { in: ['PENDING', 'RETRYING'] },
      OR: [
        { nextAttemptAt: null },
        { nextAttemptAt: { lte: now } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  const results = [];
  for (const eventRecord of dueEvents) {
    results.push(await processWebhookEvent(eventRecord));
  }
  return results;
}

function startWebhookRetryLoop({ intervalMs = 60_000 } = {}) {
  const timer = setInterval(() => {
    processDueWebhookEvents().catch((err) => {
      console.error('[webhook-inbox] retry loop failed:', err);
    });
  }, intervalMs);
  timer.unref?.();
  return timer;
}

module.exports = {
  MAX_ATTEMPTS,
  nextAttemptAt,
  recordStripeEvent,
  processWebhookEvent,
  processDueWebhookEvents,
  startWebhookRetryLoop,
};
