const {
  sanitizeNotificationSettings,
  DEFAULT_NOTIFICATION_SETTINGS,
} = require('../adminSettings');

describe('adminSettings', () => {
  test('sanitizes notification settings to bounded persisted fields', () => {
    const sanitized = sanitizeNotificationSettings({
      alerts: [
        {
          ...DEFAULT_NOTIFICATION_SETTINGS.alerts[0],
          label: 'Critical Delays '.repeat(20),
          sub: 'Delay threshold '.repeat(30),
          sms: 1,
          push: 0,
          email: true,
          unexpected: 'ignored',
        },
      ],
    });

    expect(sanitized.alerts).toHaveLength(1);
    expect(sanitized.alerts[0]).toEqual({
      type: 'delay',
      label: expect.any(String),
      sub: expect.any(String),
      sms: true,
      push: false,
      email: true,
    });
    expect(sanitized.alerts[0].label.length).toBeLessThanOrEqual(80);
    expect(sanitized.alerts[0].sub.length).toBeLessThanOrEqual(160);
    expect(sanitized.alerts[0].unexpected).toBeUndefined();
  });

  test('rejects unexpected alert types', () => {
    expect(() => sanitizeNotificationSettings({
      alerts: [{ type: 'billing-token', label: 'Bad', sub: 'Bad', sms: true, push: true, email: true }],
    })).toThrow('Invalid alert type');
  });

  test('requires alerts array', () => {
    expect(() => sanitizeNotificationSettings({ alerts: 'bad' })).toThrow('alerts must be an array');
  });
});
