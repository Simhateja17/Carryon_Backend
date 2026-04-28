jest.mock('../../lib/prisma', () => ({
  webhookEvent: {
    upsert: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
  },
  $transaction: jest.fn(),
}));

jest.mock('../stripeWebhookProcessor', () => ({
  handleStripeEvent: jest.fn(),
}));

const prisma = require('../../lib/prisma');
const { handleStripeEvent } = require('../stripeWebhookProcessor');
const {
  recordStripeEvent,
  processWebhookEvent,
  processDueWebhookEvents,
} = require('../webhookInbox');

describe('webhook inbox', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('records Stripe events by provider event id for idempotency', async () => {
    const event = { id: 'evt_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1' } } };
    prisma.webhookEvent.upsert.mockResolvedValue({ id: 'row-1', providerEventId: 'evt_1' });

    await recordStripeEvent(event);

    expect(prisma.webhookEvent.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        provider_providerEventId: {
          provider: 'stripe',
          providerEventId: 'evt_1',
        },
      },
      create: expect.objectContaining({
        provider: 'stripe',
        providerEventId: 'evt_1',
        eventType: 'payment_intent.succeeded',
        payload: event,
      }),
      update: {},
    }));
  });

  test('successful processing marks event processed once', async () => {
    const eventRecord = {
      id: 'row-1',
      provider: 'stripe',
      status: 'PENDING',
      retryCount: 0,
      payload: { id: 'evt_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1' } } },
    };
    const tx = {
      webhookEvent: {
        findUnique: jest.fn().mockResolvedValue(eventRecord),
        update: jest
          .fn()
          .mockResolvedValueOnce({ ...eventRecord, status: 'PROCESSING' })
          .mockResolvedValueOnce({ ...eventRecord, status: 'PROCESSED' }),
      },
    };
    prisma.$transaction.mockImplementation(async (fn) => fn(tx));

    const result = await processWebhookEvent(eventRecord);

    expect(handleStripeEvent).toHaveBeenCalledWith(tx, eventRecord.payload);
    expect(result.status).toBe('PROCESSED');
    expect(tx.webhookEvent.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'PROCESSED', nextAttemptAt: null }),
    }));
  });

  test('failure schedules retries and attempt four marks failed', async () => {
    const eventRecord = {
      id: 'row-1',
      provider: 'stripe',
      status: 'RETRYING',
      retryCount: 3,
      payload: { id: 'evt_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1' } } },
    };
    prisma.$transaction.mockRejectedValue(new Error('processor down'));
    prisma.webhookEvent.update.mockResolvedValue({ ...eventRecord, status: 'FAILED', retryCount: 4 });

    const result = await processWebhookEvent(eventRecord);

    expect(result.status).toBe('FAILED');
    expect(prisma.webhookEvent.update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: expect.objectContaining({
        status: 'FAILED',
        retryCount: 4,
        nextAttemptAt: null,
        lastError: 'processor down',
      }),
    });
  });

  test('processes due pending and retrying events', async () => {
    prisma.webhookEvent.findMany.mockResolvedValue([{ id: 'row-1', status: 'PROCESSED' }]);
    await processDueWebhookEvents({ now: new Date('2026-04-28T00:00:00Z'), limit: 5 });

    expect(prisma.webhookEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ['PENDING', 'RETRYING'] } }),
      take: 5,
    }));
  });
});
