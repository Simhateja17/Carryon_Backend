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
  regions: [
    { id: 'klang-valley', name: 'Klang Valley', hubCount: 42, zone: 'Greater Kuala Lumpur', enabled: true, latitude: 3.139, longitude: 101.6869, radiusKm: 40 },
    { id: 'penang', name: 'Penang', hubCount: 15, zone: 'Island and Mainland', enabled: true, latitude: 5.4164, longitude: 100.3327, radiusKm: 25 },
  ],
  vehicleClasses: VEHICLE_CATALOG.map((entry) => ({
    type: entry.type,
    label: entry.activeLabel,
    description: `${entry.label} routes. Max payload ${entry.defaultPayloadKg.toLocaleString('en-MY')}kg.`,
    enabled: true,
    pricePerKm: entry.defaultPricePerKm,
  })),
};

const VALID_ALERT_TYPES = new Set(['delay', 'order', 'offline', 'fuel']);

function sanitizeNotificationSettings(input) {
  if (!input || !Array.isArray(input.alerts)) {
    throw new Error('alerts must be an array');
  }
  if (input.alerts.length > 20) {
    throw new Error('alerts cannot contain more than 20 entries');
  }

  return {
    alerts: input.alerts.map((alert) => {
      const type = String(alert.type || '').trim();
      if (!VALID_ALERT_TYPES.has(type)) {
        throw new Error('Invalid alert type');
      }

      return {
        type,
        label: boundedText(alert.label, 80, 'alert label'),
        sub: boundedText(alert.sub, 160, 'alert description'),
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
    regions: sanitizeRegions(input.regions),
    vehicleClasses: sanitizeVehicleClasses(input.vehicleClasses),
  };
}

function mergeFleetSettings(input = {}) {
  return sanitizeFleetSettings({
    regions: Array.isArray(input.regions) ? input.regions : DEFAULT_FLEET_SETTINGS.regions,
    vehicleClasses: Array.isArray(input.vehicleClasses) ? input.vehicleClasses : DEFAULT_FLEET_SETTINGS.vehicleClasses,
  });
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

    const result = {
      id,
      name: boundedText(region.name, 80, 'region name'),
      hubCount,
      zone: boundedText(region.zone, 120, 'region zone'),
      enabled: region.enabled !== false,
      latitude: null,
      longitude: null,
      radiusKm: null,
    };

    if (region.latitude != null && region.longitude != null) {
      const lat = Number(region.latitude);
      const lng = Number(region.longitude);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
        throw new Error('region latitude must be between -90 and 90');
      }
      if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
        throw new Error('region longitude must be between -180 and 180');
      }
      const radiusKm = Number(region.radiusKm ?? 30);
      if (!Number.isFinite(radiusKm) || radiusKm < 1 || radiusKm > 200) {
        throw new Error('region radiusKm must be between 1 and 200');
      }
      result.latitude = Number(lat.toFixed(6));
      result.longitude = Number(lng.toFixed(6));
      result.radiusKm = Number(radiusKm.toFixed(1));
    }

    return result;
  });
}

// Sync: pricePerKm bounds must match FleetSettingsSchema in admin_panel route.ts
const PRICE_PER_KM_MIN = 0.10;
const PRICE_PER_KM_MAX = 50.00;

function sanitizeVehicleClasses(input) {
  if (!Array.isArray(input)) throw new Error('vehicleClasses must be an array');
  const byType = new Map();
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('vehicle class entries must be objects');
    }
    const type = normalizeVehicleType(item.type);
    if (!type) throw new Error('Invalid vehicle class type');
    const catalogDefault = VEHICLE_CATALOG.find((entry) => entry.type === type);
    const pricePerKm = Number(item.pricePerKm ?? catalogDefault?.defaultPricePerKm ?? 1);
    if (!Number.isFinite(pricePerKm) || pricePerKm < PRICE_PER_KM_MIN || pricePerKm > PRICE_PER_KM_MAX) {
      throw new Error(`pricePerKm for ${type} must be between ${PRICE_PER_KM_MIN} and ${PRICE_PER_KM_MAX}`);
    }
    byType.set(type, {
      type,
      label: boundedText(item.label || type, 80, 'vehicle class label'),
      description: boundedText(item.description || '', 180, 'vehicle class description'),
      enabled: item.enabled !== false,
      pricePerKm: Number(pricePerKm.toFixed(2)),
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
