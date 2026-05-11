jest.mock('../../lib/prisma', () => ({
  booking: {
    count: jest.fn(),
    aggregate: jest.fn(),
    findMany: jest.fn(),
    groupBy: jest.fn(),
  },
  driver: {
    count: jest.fn(),
    findMany: jest.fn(),
  },
  driverNotification: {
    count: jest.fn(),
  },
  auditLog: {
    findMany: jest.fn(),
  },
  bookingExtraCharge: {
    findMany: jest.fn(),
  },
}));

const prisma = require('../../lib/prisma');
const {
  ACTIVE_BOOKING_STATUSES,
  buildDemandHeatmap,
  getCommandCenterSnapshot,
  startOfDayInDashboardTimezone,
} = require('../adminCommandCenter');

describe('adminCommandCenter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('computes dashboard day boundaries in Malaysia operations time', () => {
    const start = startOfDayInDashboardTimezone(new Date('2026-05-11T03:30:00.000Z'));

    expect(start.toISOString()).toBe('2026-05-10T16:00:00.000Z');
  });

  test('builds demand heatmap cells from real booking timestamps', () => {
    const heatmap = buildDemandHeatmap([
      { createdAt: new Date('2026-05-11T01:00:00.000Z') },
      { createdAt: new Date('2026-05-11T02:00:00.000Z') },
      { createdAt: new Date('2026-05-10T16:30:00.000Z') },
    ]);

    expect(heatmap.max).toBe(2);
    expect(heatmap.cells[0][2]).toEqual({ count: 2, intensity: 1 });
    expect(heatmap.cells[0][0]).toEqual({ count: 1, intensity: 0.5 });
  });

  test('uses real active bookings including pending and minimizes list-view PII', async () => {
    const now = new Date('2026-05-11T04:00:00.000Z');
    prisma.booking.count
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);
    prisma.booking.aggregate
      .mockResolvedValueOnce({ _sum: { finalPrice: 1250 } })
      .mockResolvedValueOnce({ _sum: { finalPrice: 1000 } });
    prisma.driver.count.mockResolvedValue(4);
    prisma.booking.findMany
      .mockResolvedValueOnce([
        {
          id: 'booking-1',
          orderCode: 'CO-1001',
          status: 'PENDING',
          eta: null,
          updatedAt: new Date('2026-05-11T03:00:00.000Z'),
          user: { name: 'Priya Ramanathan', email: 'priya@example.com' },
          driver: null,
          pickupAddress: { label: 'Unit 12345, Long Street Name Kuala Lumpur' },
          deliveryAddress: { address: 'Warehouse 98765, Shah Alam' },
        },
      ])
      .mockResolvedValueOnce([{ createdAt: new Date('2026-05-11T01:00:00.000Z') }])
      .mockResolvedValueOnce([{ createdAt: new Date('2026-05-11T01:00:00.000Z') }])
      .mockResolvedValueOnce([]);
    prisma.driverNotification.count.mockResolvedValue(3);
    prisma.auditLog.findMany.mockResolvedValue([
      {
        action: 'BOOKING_CREATED',
        entityType: 'Booking',
        entityId: 'booking-identifier-that-is-long',
        actorType: 'USER',
        createdAt: new Date('2026-05-11T03:30:00.000Z'),
      },
    ]);
    prisma.bookingExtraCharge.findMany.mockResolvedValue([]);
    prisma.booking.groupBy.mockResolvedValue([{ status: 'PENDING', _count: { _all: 1 } }]);
    prisma.driver.findMany.mockResolvedValue([]);

    const snapshot = await getCommandCenterSnapshot({ now });

    expect(prisma.booking.findMany.mock.calls[0][0].where.status.in).toEqual(ACTIVE_BOOKING_STATUSES);
    expect(snapshot.recentOrders[0]).toMatchObject({
      id: 'CO-1001',
      customer: 'Priya R.',
      driver: 'Unassigned',
      status: 'PENDING',
    });
    expect(snapshot.recentOrders[0].route).toBe('Unit ..., Long Street Name Kual... -> Warehouse ..., Shah Alam');
    expect(snapshot.stats[2].value).toBe('RM 1.3k');
    expect(snapshot.systemLogs[0].desc).toBe('Booking booking-identifier - 30m ago');
  });
});
