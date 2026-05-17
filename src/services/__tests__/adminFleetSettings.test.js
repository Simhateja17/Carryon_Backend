const {
  FleetSettingsValidationError,
  getFleetSettingsSnapshot,
  updateFleetSettings,
} = require('../adminFleetSettings');
const { DEFAULT_FLEET_SETTINGS } = require('../adminSettings');

jest.mock('../../lib/prisma', () => ({}));

describe('adminFleetSettings', () => {
  test('builds fleet settings snapshot and seeds missing vehicle catalog rows', async () => {
    const createdVehicles = [];
    const db = {
      adminSetting: {
        findUnique: jest.fn().mockResolvedValue({
          value: {
            ...DEFAULT_FLEET_SETTINGS,
            vehicleClasses: [
              { type: 'BIKE', label: 'Bikes', description: 'Bike routes', enabled: true, pricePerKm: 1.25 },
            ],
          },
        }),
      },
      driverVehicle: {
        groupBy: jest.fn().mockResolvedValue([{ type: 'BIKE', _count: { type: 7 } }]),
      },
      vehicle: {
        findMany: jest.fn().mockResolvedValue([{ iconName: 'bike', pricePerKm: 1.75 }]),
        create: jest.fn(({ data }) => {
          const row = { id: `vehicle-${createdVehicles.length + 1}`, ...data };
          createdVehicles.push(row);
          return Promise.resolve(row);
        }),
      },
      auditLog: {
        findMany: jest.fn().mockResolvedValue([{
          action: 'ADMIN_FLEET_SETTINGS_UPDATED',
          createdAt: new Date('2026-05-17T09:30:00.000Z'),
        }]),
      },
      $transaction: jest.fn((operations) => Promise.all(operations)),
    };

    const snapshot = await getFleetSettingsSnapshot(db, new Date('2026-05-17T10:00:00.000Z'));

    expect(snapshot.currency).toBe('MYR');
    expect(snapshot.distanceUnit).toBe('km');
    expect(snapshot.settings.vehicleClasses).toHaveLength(DEFAULT_FLEET_SETTINGS.vehicleClasses.length);
    expect(snapshot.settings.vehicleClasses.find((entry) => entry.type === 'BIKE')).toEqual(
      expect.objectContaining({ active: 7, pricePerKm: 1.75 })
    );
    expect(createdVehicles).toHaveLength(DEFAULT_FLEET_SETTINGS.vehicleClasses.length - 1);
    expect(snapshot.auditItems).toEqual([
      { icon: 'edit', text: 'ADMIN FLEET SETTINGS UPDATED', time: '30m ago' },
    ]);
  });

  test('updates fleet settings, syncs vehicle pricing, and records audit', async () => {
    const payload = {
      regions: DEFAULT_FLEET_SETTINGS.regions,
      vehicleClasses: DEFAULT_FLEET_SETTINGS.vehicleClasses.map((entry) => (
        entry.type === 'BIKE' ? { ...entry, pricePerKm: 1.45 } : entry
      )),
    };
    const tx = {
      adminSetting: {
        upsert: jest.fn().mockResolvedValue({ value: payload }),
      },
      vehicle: {
        findFirst: jest.fn().mockResolvedValue({ id: 'vehicle-bike' }),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn(),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      },
    };
    const db = {
      adminSetting: {
        findUnique: jest.fn().mockResolvedValue({ value: DEFAULT_FLEET_SETTINGS }),
      },
      $transaction: jest.fn((callback) => callback(tx)),
    };

    const saved = await updateFleetSettings(payload, { actorId: 'admin-1', actorType: 'ADMIN' }, db);

    expect(saved.vehicleClasses.find((entry) => entry.type === 'BIKE').pricePerKm).toBe(1.45);
    expect(tx.adminSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'fleetInfrastructureSettings' },
      update: { value: expect.any(Object) },
      create: { key: 'fleetInfrastructureSettings', value: expect.any(Object) },
    });
    expect(tx.vehicle.update).toHaveBeenCalledWith({
      where: { id: 'vehicle-bike' },
      data: { pricePerKm: expect.any(Number) },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'admin-1',
        actorType: 'ADMIN',
        action: 'ADMIN_FLEET_SETTINGS_UPDATED',
        entityType: 'AdminSetting',
        entityId: 'fleetInfrastructureSettings',
      }),
    });
  });

  test('rejects unsafe fleet settings payloads before writing', async () => {
    const db = {
      adminSetting: { findUnique: jest.fn() },
      $transaction: jest.fn(),
    };

    await expect(updateFleetSettings({
      regions: DEFAULT_FLEET_SETTINGS.regions,
      vehicleClasses: [{ type: 'HELICOPTER', label: 'Bad', description: 'Bad', enabled: true }],
    }, { actorId: 'admin-1' }, db)).rejects.toBeInstanceOf(FleetSettingsValidationError);

    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
