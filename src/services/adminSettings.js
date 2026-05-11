const prisma = require('../lib/prisma');
const { VEHICLE_CATALOG, VALID_VEHICLE_TYPES, normalizeVehicleType } = require('./businessConfig');

const NOTIFICATION_SETTINGS_KEY = 'notificationSettings';
const FLEET_SETTINGS_KEY = 'fleetInfrastructureSettings';

const DEFAULT_NOTIFICATION_SETTINGS = {
  alerts: [
    {
      type: 'delay',
      label: 'Critical Delays',
      sub: 'Shipment is >2 hours behind schedule',
      sms: true,
      push: true,
      email: false,
    },
    {
      type: 'order',
      label: 'New Orders',
      sub: 'When a client places a new delivery request',
      sms: false,
      push: true,
      email: true,
    },
    {
      type: 'offline',
      label: 'Driver Offline',
      sub: 'Sudden disconnect during active duty',
      sms: true,
      push: true,
      email: false,
    },
    {
      type: 'fuel',
      label: 'Low Fuel Warnings',
      sub: 'Telematics detect low operational readiness',
      sms: false,
      push: true,
      email: false,
    },
  ],
};

const DEFAULT_FLEET_SETTINGS = {
  payout: {
    baseRatePerKm: 1.45,
    peakMultiplier: 1.5,
  },
  maintenance: {
    mileageThresholdEnabled: true,
    mileageThresholdKm: 5000,
    emissionCheckEnabled: true,
    telematicsFaultsEnabled: false,
    criticalNotification: 'Fleet Sync Pending',
  },
  regions: [
    { id: 'klang-valley', name: 'Klang Valley', hubCount: 42, zone: 'Greater Kuala Lumpur', enabled: true },
    { id: 'penang', name: 'Penang', hubCount: 15, zone: 'Island and Mainland', enabled: true },
  ],
  vehicleClasses: VEHICLE_CATALOG.map((entry) => ({
    type: entry.type,
    label: entry.activeLabel,
    description: `${entry.label} routes. Max payload ${entry.defaultPayloadKg.toLocaleString('en-MY')}kg.`,
    enabled: true,
  })),
};

const VALID_ALERT_TYPES = new Set(['delay', 'order', 'offline', 'fuel']);

function sanitizeNotificationSettings(input) {
  if (!input || !Array.isArray(input.alerts)) {
    throw new Error('alerts must be an array');
  }

  return {
    alerts: input.alerts.map((alert) => {
      const type = String(alert.type || '').trim();
      if (!VALID_ALERT_TYPES.has(type)) {
        throw new Error('Invalid alert type');
      }

      return {
        type,
        label: String(alert.label || '').trim().slice(0, 80),
        sub: String(alert.sub || '').trim().slice(0, 160),
        sms: Boolean(alert.sms),
        push: Boolean(alert.push),
        email: Boolean(alert.email),
      };
    }),
  };
}

function sanitizeFleetSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('fleet settings payload must be an object');
  }

  return {
    payout: sanitizePayout(input.payout),
    maintenance: sanitizeMaintenance(input.maintenance),
    regions: sanitizeRegions(input.regions),
    vehicleClasses: sanitizeVehicleClasses(input.vehicleClasses),
  };
}

function mergeFleetSettings(input = {}) {
  return sanitizeFleetSettings({
    payout: { ...DEFAULT_FLEET_SETTINGS.payout, ...(input.payout || {}) },
    maintenance: { ...DEFAULT_FLEET_SETTINGS.maintenance, ...(input.maintenance || {}) },
    regions: Array.isArray(input.regions) ? input.regions : DEFAULT_FLEET_SETTINGS.regions,
    vehicleClasses: Array.isArray(input.vehicleClasses) ? input.vehicleClasses : DEFAULT_FLEET_SETTINGS.vehicleClasses,
  });
}

function sanitizePayout(input) {
  const value = input && typeof input === 'object' ? input : {};
  const baseRatePerKm = Number(value.baseRatePerKm ?? DEFAULT_FLEET_SETTINGS.payout.baseRatePerKm);
  const peakMultiplier = Number(value.peakMultiplier ?? DEFAULT_FLEET_SETTINGS.payout.peakMultiplier);
  if (!Number.isFinite(baseRatePerKm) || baseRatePerKm < 0 || baseRatePerKm > 10000) {
    throw new Error('baseRatePerKm must be a valid non-negative number');
  }
  if (!Number.isFinite(peakMultiplier) || peakMultiplier < 1 || peakMultiplier > 10) {
    throw new Error('peakMultiplier must be between 1 and 10');
  }
  return {
    baseRatePerKm: Number(baseRatePerKm.toFixed(2)),
    peakMultiplier: Number(peakMultiplier.toFixed(2)),
  };
}

function sanitizeMaintenance(input) {
  const value = input && typeof input === 'object' ? input : {};
  const mileageThresholdKm = Number(value.mileageThresholdKm ?? DEFAULT_FLEET_SETTINGS.maintenance.mileageThresholdKm);
  if (!Number.isInteger(mileageThresholdKm) || mileageThresholdKm < 100 || mileageThresholdKm > 1000000) {
    throw new Error('mileageThresholdKm must be an integer between 100 and 1000000');
  }
  return {
    mileageThresholdEnabled: Boolean(value.mileageThresholdEnabled),
    mileageThresholdKm,
    emissionCheckEnabled: Boolean(value.emissionCheckEnabled),
    telematicsFaultsEnabled: Boolean(value.telematicsFaultsEnabled),
    criticalNotification: boundedText(value.criticalNotification || DEFAULT_FLEET_SETTINGS.maintenance.criticalNotification, 120, 'criticalNotification'),
  };
}

function sanitizeRegions(input) {
  if (!Array.isArray(input)) throw new Error('regions must be an array');
  if (input.length > 50) throw new Error('regions cannot contain more than 50 entries');
  return input.map((region) => {
    if (!region || typeof region !== 'object' || Array.isArray(region)) {
      throw new Error('region entries must be objects');
    }
    const id = slug(boundedText(region.id || region.name, 80, 'region id'));
    const hubCount = Number(region.hubCount ?? 0);
    if (!Number.isInteger(hubCount) || hubCount < 0 || hubCount > 10000) {
      throw new Error('region hubCount must be an integer between 0 and 10000');
    }
    return {
      id,
      name: boundedText(region.name, 80, 'region name'),
      hubCount,
      zone: boundedText(region.zone, 120, 'region zone'),
      enabled: region.enabled !== false,
    };
  });
}

function sanitizeVehicleClasses(input) {
  if (!Array.isArray(input)) throw new Error('vehicleClasses must be an array');
  const byType = new Map();
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('vehicle class entries must be objects');
    }
    const type = normalizeVehicleType(item.type);
    if (!type) throw new Error('Invalid vehicle class type');
    byType.set(type, {
      type,
      label: boundedText(item.label || type, 80, 'vehicle class label'),
      description: boundedText(item.description || '', 180, 'vehicle class description'),
      enabled: item.enabled !== false,
    });
  }

  return VALID_VEHICLE_TYPES.map((type) => {
    const existing = byType.get(type);
    if (existing) return existing;
    const fallback = DEFAULT_FLEET_SETTINGS.vehicleClasses.find((entry) => entry.type === type);
    return { ...fallback };
  });
}

function boundedText(value, max, fieldName) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${fieldName} is required`);
  return text.slice(0, max);
}

function slug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'region';
}

async function getAdminSetting(key, fallback) {
  const row = await prisma.adminSetting.findUnique({ where: { key } });
  return row?.value || fallback;
}

async function setAdminSettingTx(tx, key, value) {
  return tx.adminSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

module.exports = {
  NOTIFICATION_SETTINGS_KEY,
  FLEET_SETTINGS_KEY,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_FLEET_SETTINGS,
  sanitizeNotificationSettings,
  sanitizeFleetSettings,
  mergeFleetSettings,
  getAdminSetting,
  setAdminSettingTx,
};
