const {
  onlineHoursForWindow,
  setDriverOnlineStatus,
  sessionOverlapHours,
} = require('../driverOnlineTime');

describe('Driver Online Time', () => {
  test('calculates session overlap within a reporting window', () => {
    const hours = sessionOverlapHours(
      {
        startedAt: new Date('2026-04-30T00:30:00.000Z'),
        endedAt: new Date('2026-04-30T03:15:00.000Z'),
      },
      new Date('2026-04-30T01:00:00.000Z'),
      new Date('2026-04-30T04:00:00.000Z')
    );

    expect(hours).toBe(2.25);
  });

  test('includes open sessions through the window end', () => {
    const hours = sessionOverlapHours(
      {
        startedAt: new Date('2026-04-30T01:00:00.000Z'),
        endedAt: null,
      },
      new Date('2026-04-30T00:00:00.000Z'),
      new Date('2026-04-30T02:30:00.000Z')
    );

    expect(hours).toBe(1.5);
  });

  test('opens a session when driver goes online', async () => {
    const tx = {
      driver: {
        update: jest.fn().mockResolvedValue({ id: 'driver-1', isOnline: true }),
      },
      driverOnlineSession: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'session-1' }),
        updateMany: jest.fn(),
      },
    };
    const db = { $transaction: jest.fn((callback) => callback(tx)) };
    const now = new Date('2026-04-30T01:00:00.000Z');

    await setDriverOnlineStatus('driver-1', true, { db, now });

    expect(tx.driverOnlineSession.create).toHaveBeenCalledWith({
      data: { driverId: 'driver-1', startedAt: now },
    });
    expect(tx.driverOnlineSession.updateMany).not.toHaveBeenCalled();
  });

  test('closes open sessions when driver goes offline', async () => {
    const tx = {
      driver: {
        update: jest.fn().mockResolvedValue({ id: 'driver-1', isOnline: false }),
      },
      driverOnlineSession: {
        findFirst: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const db = { $transaction: jest.fn((callback) => callback(tx)) };
    const now = new Date('2026-04-30T02:00:00.000Z');

    await setDriverOnlineStatus('driver-1', false, { db, now });

    expect(tx.driverOnlineSession.updateMany).toHaveBeenCalledWith({
      where: { driverId: 'driver-1', endedAt: null },
      data: { endedAt: now },
    });
    expect(tx.driverOnlineSession.create).not.toHaveBeenCalled();
  });

  test('sums rounded online hours for a window', async () => {
    const db = {
      driverOnlineSession: {
        findMany: jest.fn().mockResolvedValue([
          {
            startedAt: new Date('2026-04-30T00:00:00.000Z'),
            endedAt: new Date('2026-04-30T01:15:00.000Z'),
          },
          {
            startedAt: new Date('2026-04-30T02:00:00.000Z'),
            endedAt: null,
          },
        ]),
      },
    };

    const hours = await onlineHoursForWindow(
      'driver-1',
      new Date('2026-04-30T00:00:00.000Z'),
      new Date('2026-04-30T03:00:00.000Z'),
      { db }
    );

    expect(hours).toBe(2.25);
  });
});
