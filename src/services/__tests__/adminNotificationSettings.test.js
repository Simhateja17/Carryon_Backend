const {
  getNotificationSettingsSnapshot,
  minutesAgo,
  normalizeStoredNotificationSettings,
} = require('../adminNotificationSettings');
const { DEFAULT_NOTIFICATION_SETTINGS } = require('../adminSettings');

jest.mock('../../lib/prisma', () => ({
  adminSetting: { findUnique: jest.fn() },
}));

describe('adminNotificationSettings', () => {
  test('builds notification settings snapshot from persisted settings and operational data', async () => {
    const now = new Date('2026-05-17T10:00:00.000Z');
    const db = {
      adminSetting: {
        findUnique: jest.fn().mockResolvedValue({
          value: {
            alerts: [{
              type: 'delay',
              label: 'Critical Delays',
              sub: 'Late delivery',
              sms: true,
              push: true,
              email: false,
            }],
          },
        }),
      },
      driver: {
        count: jest.fn()
          .mockResolvedValueOnce(10)
          .mockResolvedValueOnce(3)
          .mockResolvedValueOnce(8),
      },
      auditLog: {
        groupBy: jest.fn().mockResolvedValue([{ actorId: 'admin-1' }, { actorId: 'admin-2' }]),
        findMany: jest.fn().mockResolvedValue([{
          action: 'ADMIN_NOTIFICATION_SETTINGS_UPDATED',
          createdAt: new Date('2026-05-17T09:30:00.000Z'),
        }]),
      },
      driverNotification: {
        count: jest.fn().mockResolvedValue(24),
      },
    };

    const snapshot = await getNotificationSettingsSnapshot(db, now);

    expect(snapshot.settings.alerts).toHaveLength(1);
    expect(snapshot.groups).toEqual([
      expect.objectContaining({ type: 'admin', sub: '2 admin actors - Global access' }),
      expect.objectContaining({ type: 'dispatch', sub: '3 online drivers - Live ops' }),
      expect.objectContaining({ type: 'driver', sub: '8/10 drivers with push enabled' }),
    ]);
    expect(snapshot.health).toEqual({ deliveryRate: 80, deliveredLast24h: 24 });
    expect(snapshot.auditItems).toEqual([
      { icon: 'edit', text: 'Admin Notification Settings Updated', time: '30m ago' },
    ]);
    expect(db.driverNotification.count).toHaveBeenCalledWith({
      where: { createdAt: { gte: new Date('2026-05-16T10:00:00.000Z') } },
    });
  });

  test('formats older audit items in days', () => {
    expect(minutesAgo(
      new Date('2026-05-15T10:00:00.000Z'),
      new Date('2026-05-17T10:00:00.000Z')
    )).toBe('2d ago');
  });

  test('normalizes unsafe stored notification settings to defaults', () => {
    expect(normalizeStoredNotificationSettings({
      alerts: [{ type: 'unknown', label: 'Bad', sub: 'Bad', sms: true, push: true, email: true }],
    })).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
  });
});
