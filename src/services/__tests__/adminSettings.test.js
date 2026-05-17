const {
  sanitizeNotificationSettings,
  sanitizeFleetSettings,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_FLEET_SETTINGS,
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

  test('requires bounded non-empty notification alert fields', () => {
    expect(() => sanitizeNotificationSettings({
      alerts: [{ ...DEFAULT_NOTIFICATION_SETTINGS.alerts[0], label: '' }],
    })).toThrow('alert label is required');

    expect(() => sanitizeNotificationSettings({
      alerts: Array.from({ length: 21 }, () => DEFAULT_NOTIFICATION_SETTINGS.alerts[0]),
    })).toThrow('alerts cannot contain more than 20 entries');
  });

  test('sanitizes fleet settings and restores missing canonical vehicle classes', () => {
    const sanitized = sanitizeFleetSettings({
      regions: [{ id: 'Klang Valley', name: 'Klang Valley', hubCount: 12, zone: 'Greater KL', enabled: true }],
      vehicleClasses: [{ type: 'BIKE', label: 'Bikes', description: 'Bike routes', enabled: true }],
    });

    expect(sanitized.regions[0]).toEqual({
      id: 'klang-valley',
      name: 'Klang Valley',
      hubCount: 12,
      zone: 'Greater KL',
      enabled: true,
      latitude: null,
      longitude: null,
      radiusKm: null,
    });
    expect(sanitized.vehicleClasses).toHaveLength(DEFAULT_FLEET_SETTINGS.vehicleClasses.length);
    expect(sanitized.vehicleClasses.map((entry) => entry.type)).toContain('LORRY_17FT');
  });

  test('rejects unsafe fleet settings payloads', () => {
    expect(() => sanitizeFleetSettings({
      regions: DEFAULT_FLEET_SETTINGS.regions,
      vehicleClasses: [{ type: 'HELICOPTER', label: 'Bad', description: 'Bad', enabled: true }],
    })).toThrow('Invalid vehicle class type');
  });
});
