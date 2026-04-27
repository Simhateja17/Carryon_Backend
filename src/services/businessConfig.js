// ── Business Config Module ──────────────────────────────────
// Single source of truth for tunable business parameters.
// Every module that needs a business constant reads it here.

const VEHICLE_RATE_PER_KM = {
  BIKE:       { regular: 0.90,  priority: 1.50,  pooling: 0.68  },
  CAR:        { regular: 1.17,  priority: 1.88,  pooling: 0.88  },
  PICKUP:     { regular: 3.40,  priority: 5.90,  pooling: 3.00  },
  VAN_7FT:    { regular: 5.40,  priority: 9.44,  pooling: 4.85  },
  VAN_9FT:    { regular: 6.40,  priority: 10.69, pooling: 5.83  },
  LORRY_10FT: { regular: 8.23,  priority: 14.40, pooling: 7.40  },
  LORRY_14FT: { regular: 11.60, priority: 22.60, pooling: 10.44 },
  LORRY_17FT: { regular: 15.60, priority: 26.60, pooling: 13.70 },
};

const VALID_VEHICLE_TYPES = Object.keys(VEHICLE_RATE_PER_KM);

const VALID_PAYMENT_METHODS = ['CASH', 'UPI', 'CARD', 'WALLET'];

const DRIVER_COMMISSION_RATE = Number(process.env.DRIVER_COMMISSION_RATE || 0.88);

const DRIVER_SEARCH_RADIUS_KM = 10;

const OFFER_EXPIRY_MS = 60 * 1000;

const DELIVERY_OTP_LENGTH = 6;
const DELIVERY_OTP_TTL_MS = 10 * 60 * 1000;
const DELIVERY_OTP_RESEND_COOLDOWN_MS = 30 * 1000;

const REFERRAL_REWARD_AMOUNT = 5.0; // RM 5

module.exports = {
  VEHICLE_RATE_PER_KM,
  VALID_VEHICLE_TYPES,
  VALID_PAYMENT_METHODS,
  DRIVER_COMMISSION_RATE,
  DRIVER_SEARCH_RADIUS_KM,
  OFFER_EXPIRY_MS,
  DELIVERY_OTP_LENGTH,
  DELIVERY_OTP_TTL_MS,
  DELIVERY_OTP_RESEND_COOLDOWN_MS,
  REFERRAL_REWARD_AMOUNT,
};
