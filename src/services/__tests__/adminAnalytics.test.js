jest.mock('../../lib/prisma', () => ({
  booking: {
    findMany: jest.fn(),
    aggregate: jest.fn(),
  },
  driver: {
    count: jest.fn(),
    findMany: jest.fn(),
  },
  driverWalletTransaction: {
    aggregate: jest.fn(),
  },
}));

const prisma = require('../../lib/prisma');
const {
  averageDeliveryMinutes,
  buildBreakdown,
  getAnalyticsSnapshot,
  resolveAnalyticsWindow,
  startOfDayInAnalyticsTimezone,
} = require('../adminAnalytics');

describe('adminAnalytics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('resolves today using Malaysia operations time', () => {
    const start = startOfDayInAnalyticsTimezone(new Date('2026-05-11T03:30:00.000Z'));
    expect(start.toISOString()).toBe('2026-05-10T16:00:00.000Z');

    const window = resolveAnalyticsWindow('today', new Date('2026-05-11T03:30:00.000Z'));
    expect(window.start.toISOString()).toBe('2026-05-10T16:00:00.000Z');
    expect(window.previousStart.toISOString()).toBe('2026-05-09T16:00:00.000Z');
  });

  test('builds booking status breakdown from real statuses', () => {
    expect(buildBreakdown([
      { status: 'DELIVERED' },
      { status: 'DELIVERED' },
      { status: 'IN_TRANSIT' },
      { status: 'CANCELLED' },
    ])).toEqual([
      { label: 'DELIVERED', count: 2, pct: 50 },
      { label: 'PENDING', count: 1, pct: 25 },
      { label: 'CANCELLED', count: 1, pct: 25 },
    ]);
  });

  test('prefers deliveredAt duration and ignores incomplete deliveries', () => {
    expect(averageDeliveryMinutes([
      { status: 'DELIVERED', createdAt: new Date('2026-05-11T00:00:00Z'), deliveredAt: new Date('2026-05-11T00:24:00Z') },
      { status: 'DELIVERED', createdAt: new Date('2026-05-11T01:00:00Z'), duration: 36 },
      { status: 'IN_TRANSIT', createdAt: new Date('2026-05-11T02:00:00Z'), duration: 999 },
    ])).toBe(30);
  });

  test('returns a PII-light analytics snapshot', async () => {
    const now = new Date('2026-05-11T04:00:00.000Z');
    prisma.booking.findMany
      .mockResolvedValueOnce([
        {
          id: 'b1',
          driverId: 'd1',
          status: 'DELIVERED',
          finalPrice: 100,
          discountAmount: 5,
          duration: 20,
          createdAt: new Date('2026-05-11T01:00:00.000Z'),
          updatedAt: new Date('2026-05-11T01:20:00.000Z'),
          deliveredAt: new Date('2026-05-11T01:20:00.000Z'),
          deliveryAddress: { label: '', address: 'A Street, Kuala Lumpur, Malaysia' },
          order: { rating: 5 },
        },
        {
          id: 'b2',
          driverId: 'd1',
          status: 'CANCELLED',
          finalPrice: 20,
          discountAmount: 0,
          duration: 0,
          createdAt: new Date('2026-05-11T02:00:00.000Z'),
          updatedAt: new Date('2026-05-11T02:10:00.000Z'),
          deliveredAt: null,
          deliveryAddress: { label: '', address: 'B Street, Shah Alam, Malaysia' },
          order: { rating: null },
        },
      ])
      .mockResolvedValueOnce([
        { status: 'DELIVERED', finalPrice: 50, duration: 30, createdAt: new Date('2026-05-10T01:00:00.000Z'), deliveredAt: null, order: { rating: 4 } },
      ])
      .mockResolvedValueOnce([
        { status: 'DELIVERED', finalPrice: 100, createdAt: new Date('2026-05-11T01:00:00.000Z') },
        { status: 'CANCELLED', finalPrice: 20, createdAt: new Date('2026-05-11T02:00:00.000Z') },
      ]);
    prisma.driver.count.mockResolvedValue(3);
    prisma.driver.findMany.mockResolvedValue([{ id: 'd1', name: 'Driver One', photo: null, isOnline: true, rating: 4.7, totalTrips: 30, vehicle: { type: 'CAR' } }]);
    prisma.booking.aggregate.mockResolvedValue({ _sum: { cancellationFee: 2 } });
    prisma.driverWalletTransaction.aggregate.mockResolvedValue({ _sum: { platformFeeAmount: 25 } });

    const snapshot = await getAnalyticsSnapshot({ period: 'today', now });

    expect(snapshot.metrics.totalOrders.value).toBe(2);
    expect(snapshot.metrics.totalRevenue.value).toBe(100);
    expect(snapshot.metrics.cancelRatePct.value).toBe(50);
    expect(snapshot.driverPerformance[0]).toMatchObject({ name: 'Driver One', acceptancePct: 50, cancelRatePct: 50 });
    expect(JSON.stringify(snapshot)).not.toContain('A Street');
  });
});
