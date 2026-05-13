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
    const db = {
      driver: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'driver-1',
          isVerified: true,
          verificationStatus: 'APPROVED',
          documents: [
            { type: 'DRIVERS_LICENSE', status: 'APPROVED', expiryDate: '2027-01-01' },
            { type: 'ROAD_TAX', status: 'APPROVED', expiryDate: '2027-01-01' },
            { type: 'INSURANCE', status: 'APPROVED', expiryDate: '2027-01-01' },
          ],
        }),
      },
      $transaction: jest.fn((callback) => callback(tx)),
    };
    const now = new Date('2026-04-30T01:00:00.000Z');
    const serviceAreaCheck = jest.fn().mockResolvedValue({ allowed: true });

    await setDriverOnlineStatus('driver-1', true, {
      db,
      now,
      location: { latitude: 37.390026, longitude: -122.08123 },
      serviceAreaCheck,
    });

    expect(serviceAreaCheck).toHaveBeenCalledWith(37.390026, -122.08123);
    expect(tx.driver.update).toHaveBeenCalledWith({
      where: { id: 'driver-1' },
      data: {
        isOnline: true,
        currentLatitude: 37.390026,
        currentLongitude: -122.08123,
      },
    });
    expect(tx.driverOnlineSession.create).toHaveBeenCalledWith({
      data: { driverId: 'driver-1', startedAt: now },
    });
    expect(tx.driverOnlineSession.updateMany).not.toHaveBeenCalled();
  });

  test('requires a current location when driver goes online', async () => {
    const db = {
      driver: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'driver-1',
          isVerified: true,
          verificationStatus: 'APPROVED',
          currentLatitude: 0,
          currentLongitude: 0,
          documents: [
            { type: 'DRIVERS_LICENSE', status: 'APPROVED', expiryDate: '2027-01-01' },
            { type: 'ROAD_TAX', status: 'APPROVED', expiryDate: '2027-01-01' },
            { type: 'INSURANCE', status: 'APPROVED', expiryDate: '2027-01-01' },
          ],
        }),
      },
      $transaction: jest.fn(),
    };
    const serviceAreaCheck = jest.fn();

    await expect(
      setDriverOnlineStatus('driver-1', true, { db, serviceAreaCheck })
    ).rejects.toThrow('Current location is required to go online.');

    expect(serviceAreaCheck).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
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
