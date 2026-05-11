// ── Business Config Module ──────────────────────────────────
// Single source of truth for tunable business parameters.
// Every module that needs a business constant reads it here.

const VEHICLE_RATE_PER_KM = {
  BIKE:       { regular: 0.90,  priority: 1.50,  pooling: 0.68  },
  CAR:        { regular: 1.17,  priority: 1.88,  pooling: 0.88  },
  PICKUP:     { regular: 3.40,  priority: 5.90,  pooling: 3.00  },
  VAN_7FT:    { regular: 5.40,  priority: 9.44,  pooling: 4.85  },
  VAN_9FT:    { regular: 6.40,  priority: 10.69, pooling: 5.83  },
  LORRY_10FT: { regular: 8.23,  priority: 14.40, pooling: 7.40 },
  LORRY_14FT: { regular: 11.60, priority: 22.60, pooling: 10.44 },
  LORRY_17FT: { regular: 15.60, priority: 26.60, pooling: 13.70 },
};

const VEHICLE_CATALOG = [
  { type: 'BIKE', label: 'Bike', icon: 'bike', activeLabel: 'Bikes', defaultPayloadKg: 25, defaultBasePrice: 2.70, defaultPricePerKm: 0.90, defaultMinimumFare: 4.50 },
  { type: 'CAR', label: 'Car', icon: 'car', activeLabel: 'Cars', defaultPayloadKg: 400, defaultBasePrice: 3.51, defaultPricePerKm: 1.17, defaultMinimumFare: 5.85 },
  { type: 'PICKUP', label: 'Pickup', icon: 'pickup', activeLabel: 'Pickups', defaultPayloadKg: 800, defaultBasePrice: 10.20, defaultPricePerKm: 3.40, defaultMinimumFare: 17.00 },
  { type: 'VAN_7FT', label: 'Van 7ft', icon: 'van', activeLabel: '7ft Vans', defaultPayloadKg: 1200, defaultBasePrice: 16.20, defaultPricePerKm: 5.40, defaultMinimumFare: 27.00 },
  { type: 'VAN_9FT', label: 'Van 9ft', icon: 'van', activeLabel: '9ft Vans', defaultPayloadKg: 1600, defaultBasePrice: 19.20, defaultPricePerKm: 6.40, defaultMinimumFare: 32.00 },
  { type: 'LORRY_10FT', label: 'Lorry 10ft', icon: 'truck', activeLabel: '10ft Lorries', defaultPayloadKg: 3000, defaultBasePrice: 24.69, defaultPricePerKm: 8.23, defaultMinimumFare: 41.15 },
  { type: 'LORRY_14FT', label: 'Lorry 14ft', icon: 'truck', activeLabel: '14ft Lorries', defaultPayloadKg: 5000, defaultBasePrice: 34.80, defaultPricePerKm: 11.60, defaultMinimumFare: 58.00 },
  { type: 'LORRY_17FT', label: 'Lorry 17ft', icon: 'truck', activeLabel: '17ft Lorries', defaultPayloadKg: 8000, defaultBasePrice: 46.80, defaultPricePerKm: 15.60, defaultMinimumFare: 78.00 },
];

const VALID_VEHICLE_TYPES = VEHICLE_CATALOG.map((entry) => entry.type);
const VEHICLE_CATALOG_BY_TYPE = new Map(VEHICLE_CATALOG.map((entry) => [entry.type, entry]));

const VALID_PAYMENT_METHODS = ['CASH', 'UPI', 'CARD', 'WALLET'];

const DRIVER_COMMISSION_RATE = Number(process.env.DRIVER_COMMISSION_RATE || 0.88);

const DRIVER_SEARCH_RADIUS_KM = 10;

const OFFER_EXPIRY_MS = 60 * 1000;

const DELIVERY_OTP_LENGTH = 6;
const DELIVERY_OTP_TTL_MS = 10 * 60 * 1000;
const DELIVERY_OTP_RESEND_COOLDOWN_MS = 30 * 1000;
const OTP_MAX_VERIFY_ATTEMPTS = Number(process.env.OTP_MAX_VERIFY_ATTEMPTS || 5);
const OTP_VERIFY_LOCK_MS = Number(process.env.OTP_VERIFY_LOCK_MS || 10 * 60 * 1000);

const REFERRAL_REWARD_AMOUNT = 5.0; // RM 5
const OFFLOADING_FEE = Number(process.env.OFFLOADING_FEE || 30);
const BOOKING_TAX_RATE = Number(process.env.BOOKING_TAX_RATE || 0.05);
const COMPANY_INVOICE_PROFILE = {
  name: process.env.COMPANY_NAME || 'CarryOn Logistics Sdn Bhd',
  registration: process.env.COMPANY_REGISTRATION || '',
  sstNo: process.env.COMPANY_SST_NO || '',
  address: process.env.COMPANY_ADDRESS || '',
  phone: process.env.COMPANY_PHONE || '',
  email: process.env.COMPANY_BILLING_EMAIL || 'billing@carryon.my',
};

function normalizeVehicleType(value) {
  const normalized = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  return VEHICLE_CATALOG_BY_TYPE.has(normalized) ? normalized : null;
}

function vehicleCatalogEntry(type) {
  const normalized = normalizeVehicleType(type);
  return normalized ? VEHICLE_CATALOG_BY_TYPE.get(normalized) : null;
}

function vehicleLabel(type) {
  return vehicleCatalogEntry(type)?.label || String(type || '').replace(/_/g, ' ');
}

function defaultVehiclePricing(type) {
  const entry = vehicleCatalogEntry(type);
  if (!entry) return null;
  return {
    id: null,
    type: entry.type,
    name: entry.label,
    basePrice: entry.defaultBasePrice,
    pricePerKm: entry.defaultPricePerKm,
    minimumFare: entry.defaultMinimumFare,
    isAvailable: true,
  };
}

function projectVehicleCatalogRow(type, overrides = {}) {
  const entry = vehicleCatalogEntry(type);
  if (!entry) return null;
  return {
    ...entry,
    ...overrides,
    type: entry.type,
    label: overrides.label || entry.label,
  };
}

module.exports = {
  VEHICLE_RATE_PER_KM,
  VEHICLE_CATALOG,
  VALID_VEHICLE_TYPES,
  VALID_PAYMENT_METHODS,
  DRIVER_COMMISSION_RATE,
  DRIVER_SEARCH_RADIUS_KM,
  OFFER_EXPIRY_MS,
  DELIVERY_OTP_LENGTH,
  DELIVERY_OTP_TTL_MS,
  DELIVERY_OTP_RESEND_COOLDOWN_MS,
  OTP_MAX_VERIFY_ATTEMPTS,
  OTP_VERIFY_LOCK_MS,
  REFERRAL_REWARD_AMOUNT,
  OFFLOADING_FEE,
  BOOKING_TAX_RATE,
  COMPANY_INVOICE_PROFILE,
  normalizeVehicleType,
  vehicleCatalogEntry,
  vehicleLabel,
  defaultVehiclePricing,
  projectVehicleCatalogRow,
};
