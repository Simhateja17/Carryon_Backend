const prisma = require('../lib/prisma');
const { recordAudit } = require('./auditLog');
const {
  FLEET_SETTINGS_KEY,
  DEFAULT_FLEET_SETTINGS,
  mergeFleetSettings,
  sanitizeFleetSettings,
  setAdminSettingTx,
} = require('./adminSettings');
const { VEHICLE_CATALOG, normalizeVehicleType } = require('./businessConfig');

class FleetSettingsValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FleetSettingsValidationError';
  }
}

function minutesAgo(date, now = new Date()) {
  if (!date) return '--';
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(date).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / (60 * 24))}d ago`;
}

function vehicleSeedData(entry) {
  return {
    name: entry.label,
    description: `${entry.label} routes. Max payload ${entry.defaultPayloadKg}kg.`,
    capacity: `${entry.defaultPayloadKg}kg`,
    basePrice: entry.defaultBasePrice,
    pricePerKm: entry.defaultPricePerKm,
    iconName: entry.type.toLowerCase(),
    isAvailable: true,
  };
}

async function ensureFleetVehicleCatalog(db, existingVehicles) {
  const existingTypes = new Set();
  for (const vehicle of existingVehicles) {
    const type = normalizeVehicleType(vehicle.iconName);
    if (type) existingTypes.add(type);
  }

  const missing = VEHICLE_CATALOG.filter((entry) => !existingTypes.has(entry.type));
  if (missing.length === 0) return existingVehicles;

  const createOperations = missing.map((entry) => db.vehicle.create({ data: vehicleSeedData(entry) }));
  const created = typeof db.$transaction === 'function'
    ? await db.$transaction(createOperations)
    : await Promise.all(createOperations);
  return [...existingVehicles, ...created];
}

function fleetVehiclePriceMap(vehicles) {
  const dbPriceByType = new Map();
  for (const vehicle of vehicles) {
    const type = normalizeVehicleType(vehicle.iconName);
    if (type && vehicle.pricePerKm > 0 && !dbPriceByType.has(type)) {
      dbPriceByType.set(type, vehicle.pricePerKm);
    }
  }
  return dbPriceByType;
}

function formatAuditItems(auditItems, now = new Date()) {
  return auditItems.map((item) => ({
    icon: 'edit',
    text: String(item.action || '').replace(/_/g, ' '),
    time: minutesAgo(item.createdAt, now),
  }));
}

async function readFleetSetting(db) {
  const row = await db.adminSetting.findUnique({ where: { key: FLEET_SETTINGS_KEY } });
  return row?.value || DEFAULT_FLEET_SETTINGS;
}

async function getFleetSettingsSnapshot(db = prisma, now = new Date()) {
  const [persisted, activeByType, rawVehicles, auditItems] = await Promise.all([
    readFleetSetting(db),
    db.driverVehicle.groupBy({ by: ['type'], _count: { type: true } }),
    db.vehicle.findMany({ select: { iconName: true, pricePerKm: true } }),
    db.auditLog.findMany({
      where: { action: 'ADMIN_FLEET_SETTINGS_UPDATED' },
      orderBy: { createdAt: 'desc' },
      take: 4,
    }),
  ]);

  const vehicles = await ensureFleetVehicleCatalog(db, rawVehicles);
  const activeCounts = new Map(activeByType.map((entry) => [entry.type, entry._count.type]));
  const dbPriceByType = fleetVehiclePriceMap(vehicles);
  const settings = mergeFleetSettings(persisted);

  return {
    settings: {
      ...settings,
      vehicleClasses: settings.vehicleClasses.map((entry) => {
        const catalogDefault = VEHICLE_CATALOG.find((catalogEntry) => catalogEntry.type === entry.type);
        return {
          ...entry,
          active: activeCounts.get(entry.type) || 0,
          pricePerKm: dbPriceByType.get(entry.type) || entry.pricePerKm || catalogDefault?.defaultPricePerKm || 1,
        };
      }),
    },
    currency: 'MYR',
    distanceUnit: 'km',
    auditItems: formatAuditItems(auditItems, now),
  };
}

async function syncFleetVehiclePricing(tx, vehicleClasses) {
  for (const vehicleClass of vehicleClasses) {
    if (vehicleClass.pricePerKm == null) continue;

    const catalogEntry = VEHICLE_CATALOG.find((entry) => entry.type === vehicleClass.type);
    const iconName = vehicleClass.type.toLowerCase();
    const existing = await tx.vehicle.findFirst({
      where: { OR: [{ iconName }, { iconName: vehicleClass.type }] },
      select: { id: true },
    });

    if (existing) {
      await tx.vehicle.update({
        where: { id: existing.id },
        data: { pricePerKm: vehicleClass.pricePerKm },
      });
    } else {
      await tx.vehicle.create({
        data: {
          name: catalogEntry?.label || vehicleClass.label,
          description: vehicleClass.description || '',
          capacity: '',
          basePrice: catalogEntry?.defaultBasePrice || 0,
          pricePerKm: vehicleClass.pricePerKm,
          iconName,
          isAvailable: vehicleClass.enabled,
        },
      });
    }
  }
}

async function updateFleetSettings(input, actor, db = prisma) {
  let nextSettings;
  try {
    nextSettings = sanitizeFleetSettings(input);
  } catch (err) {
    throw new FleetSettingsValidationError(err.message);
  }

  const previous = mergeFleetSettings(await readFleetSetting(db));
  const saved = await db.$transaction(async (tx) => {
    const setting = await setAdminSettingTx(tx, FLEET_SETTINGS_KEY, nextSettings);
    await syncFleetVehiclePricing(tx, nextSettings.vehicleClasses);
    await recordAudit(tx, {
      actor,
      action: 'ADMIN_FLEET_SETTINGS_UPDATED',
      entityType: 'AdminSetting',
      entityId: FLEET_SETTINGS_KEY,
      oldValue: previous,
      newValue: nextSettings,
    });
    return setting;
  });

  return saved.value;
}

module.exports = {
  FleetSettingsValidationError,
  getFleetSettingsSnapshot,
  updateFleetSettings,
  ensureFleetVehicleCatalog,
  minutesAgo,
};
