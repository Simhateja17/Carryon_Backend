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

  test('sanitizes fleet settings and restores missing canonical vehicle classes', () => {
    const sanitized = sanitizeFleetSettings({
      payout: { baseRatePerKm: '2.555', peakMultiplier: 1.25 },
      maintenance: {
        mileageThresholdEnabled: 1,
        mileageThresholdKm: 7500,
        emissionCheckEnabled: false,
        telematicsFaultsEnabled: true,
        criticalNotification: 'Diagnostics queued',
      },
      regions: [{ id: 'Klang Valley', name: 'Klang Valley', hubCount: 12, zone: 'Greater KL', enabled: true }],
      vehicleClasses: [{ type: 'BIKE', label: 'Bikes', description: 'Bike routes', enabled: true }],
    });

    expect(sanitized.payout).toEqual({ baseRatePerKm: 2.56, peakMultiplier: 1.25 });
    expect(sanitized.regions[0]).toEqual({
      id: 'klang-valley',
      name: 'Klang Valley',
      hubCount: 12,
      zone: 'Greater KL',
      enabled: true,
    });
    expect(sanitized.vehicleClasses).toHaveLength(DEFAULT_FLEET_SETTINGS.vehicleClasses.length);
    expect(sanitized.vehicleClasses.map((entry) => entry.type)).toContain('LORRY_17FT');
  });

  test('rejects unsafe fleet settings payloads', () => {
    expect(() => sanitizeFleetSettings({
      payout: { baseRatePerKm: -1, peakMultiplier: 1 },
      maintenance: DEFAULT_FLEET_SETTINGS.maintenance,
      regions: DEFAULT_FLEET_SETTINGS.regions,
      vehicleClasses: DEFAULT_FLEET_SETTINGS.vehicleClasses,
    })).toThrow('baseRatePerKm');

    expect(() => sanitizeFleetSettings({
      payout: DEFAULT_FLEET_SETTINGS.payout,
      maintenance: DEFAULT_FLEET_SETTINGS.maintenance,
      regions: DEFAULT_FLEET_SETTINGS.regions,
      vehicleClasses: [{ type: 'HELICOPTER', label: 'Bad', description: 'Bad', enabled: true }],
    })).toThrow('Invalid vehicle class type');
  });
});
