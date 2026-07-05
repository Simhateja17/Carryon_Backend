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
  if (eventRecord.status === 'PROCESSED' || eventRecord.status === 'FAILED') {
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
    return processedEvent;
  } catch (err) {
    const retryCount = (eventRecord.retryCount || 0) + 1;
    const failed = retryCount >= MAX_ATTEMPTS;
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
    const booking = await prisma.booking.findUnique({
      where: { id: task.bookingId },
      include: { pickupAddress: true, deliveryAddress: true, driver: true },
    });
    if (!booking || booking.status !== 'SEARCHING_DRIVER' || booking.paymentStatus !== 'COMPLETED') continue;
    notifyNearbyDrivers(booking).catch((err) => {
      console.error('[webhook-inbox] post-payment dispatch failed:', err.message);
    });
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
