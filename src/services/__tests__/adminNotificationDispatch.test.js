const {
  dispatchAdminNotification,
  validateAdminNotificationPayload,
} = require('../adminNotificationDispatch');

jest.mock('../../lib/prisma', () => ({}));
jest.mock('../../lib/pushNotifications', () => ({
  sendPushToDriverIds: jest.fn(),
}));

describe('adminNotificationDispatch', () => {
  test('persists notifications, sends push, and records an audit summary', async () => {
    const db = {
      driver: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'driver-1', name: 'Asha', email: 'asha@example.com' },
          { id: 'driver-2', name: 'Ben', email: 'ben@example.com' },
        ]),
      },
      driverNotification: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      },
    };
    const pushSender = jest.fn().mockResolvedValue({
      devices: [{ driverId: 'driver-1', token: 'token-1' }],
      successCount: 1,
      failureCount: 0,
      failedTokens: [],
      invalidTokens: [],
      cleanedInvalidTokens: 0,
      deliveredActorIds: ['driver-1'],
      failedActorIds: [],
      noDeviceActorIds: ['driver-2'],
    });

    const result = await dispatchAdminNotification(
      { title: 'Ops alert', message: 'Check route', type: 'ALERT', audience: 'online' },
      { actorId: 'admin-1', actorType: 'ADMIN' },
      db,
      pushSender
    );

    expect(db.driver.findMany).toHaveBeenCalledWith({
      where: { isOnline: true },
      select: { id: true, name: true, email: true },
    });
    expect(db.driverNotification.createMany).toHaveBeenCalledWith({
      data: [
        { driverId: 'driver-1', title: 'Ops alert', message: 'Check route', type: 'ALERT' },
        { driverId: 'driver-2', title: 'Ops alert', message: 'Check route', type: 'ALERT' },
      ],
    });
    expect(pushSender).toHaveBeenCalledWith(
      ['driver-1', 'driver-2'],
      { title: 'Ops alert', body: 'Check route' },
      { type: 'ALERT', source: 'admin' }
    );
    expect(result.push).toEqual(expect.objectContaining({
      attempted: 1,
      delivered: 1,
      failed: 0,
      driversWithoutToken: 1,
      deliveredDrivers: [{ id: 'driver-1', name: 'Asha', email: 'asha@example.com' }],
      noTokenDrivers: [{ id: 'driver-2', name: 'Ben', email: 'ben@example.com' }],
    }));
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'admin-1',
        actorType: 'ADMIN',
        action: 'ADMIN_NOTIFICATION_SENT',
        entityType: 'DriverNotification',
        entityId: 'bulk',
        newValue: expect.objectContaining({
          audience: 'online',
          type: 'ALERT',
          sent: 2,
          pushDelivered: 1,
        }),
      }),
    });
  });

  test('records no-driver sends without invoking push', async () => {
    const db = {
      driver: { findMany: jest.fn().mockResolvedValue([]) },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    };
    const pushSender = jest.fn();

    const result = await dispatchAdminNotification(
      { title: 'Ops alert', message: 'Check route', type: 'SYSTEM', audience: 'all' },
      { actorId: 'admin-1', actorType: 'ADMIN' },
      db,
      pushSender
    );

    expect(result).toEqual({ sent: 0, message: 'No matching drivers found' });
    expect(pushSender).not.toHaveBeenCalled();
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'ADMIN_NOTIFICATION_SENT',
        entityId: 'none',
        newValue: expect.objectContaining({ sent: 0, driversCount: 0 }),
      }),
    });
  });

  test('does not fail a completed dispatch when audit recording fails', async () => {
    const db = {
      driver: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'driver-1', name: 'Asha', email: 'asha@example.com' },
        ]),
      },
      driverNotification: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: {
        create: jest.fn().mockRejectedValue(new Error('audit unavailable')),
      },
    };
    const pushSender = jest.fn().mockResolvedValue({
      devices: [],
      successCount: 0,
      failureCount: 0,
      failedTokens: [],
      invalidTokens: [],
      cleanedInvalidTokens: 0,
      deliveredActorIds: [],
      failedActorIds: [],
      noDeviceActorIds: ['driver-1'],
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(dispatchAdminNotification(
      { title: 'Ops alert', message: 'Check route', type: 'ALERT', audience: 'all' },
      { actorId: 'admin-1', actorType: 'ADMIN' },
      db,
      pushSender
    )).resolves.toEqual(expect.objectContaining({ sent: 1 }));

    expect(warn).toHaveBeenCalledWith(
      '[admin-notifications] audit write failed after dispatch',
      expect.objectContaining({ action: 'ADMIN_NOTIFICATION_SENT', entityId: 'bulk' })
    );
    warn.mockRestore();
  });

  test('validates supported notification payloads', () => {
    expect(() => validateAdminNotificationPayload({ title: '', message: 'Body' })).toThrow('Title and message are required');
    expect(() => validateAdminNotificationPayload({ title: 'Title', message: 'Body', type: 'BAD' })).toThrow('Invalid type');
    expect(() => validateAdminNotificationPayload({ title: 'Title', message: 'Body', type: 'ALERT', audience: 'regional' })).toThrow('Invalid audience');
  });
});
