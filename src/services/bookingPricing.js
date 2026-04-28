// ── Booking Pricing Module ──────────────────────────────────
// Owns authoritative fare calculation for quotes and booking creation.

const prisma = require('../lib/prisma');
const locationProvider = require('./locationProvider');
const { VEHICLE_RATE_PER_KM } = require('./businessConfig');

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

const VEHICLE_NAME_CANDIDATES = {
  BIKE: ['BIKE', 'Bike', '2 Wheeler'],
  CAR: ['CAR', 'Car', 'Car (2-Seat)', 'Car (4-Seat)'],
  PICKUP: ['PICKUP', 'Pickup', '4x4 Pickup', 'Truck', 'Open Truck'],
  VAN_7FT: ['VAN_7FT', 'Van 7ft', 'Mini Van'],
  VAN_9FT: ['VAN_9FT', 'Van 9ft'],
  LORRY_10FT: ['LORRY_10FT', 'Small Lorry 10ft'],
  LORRY_14FT: ['LORRY_14FT', 'Medium Lorry 14ft'],
  LORRY_17FT: ['LORRY_17FT', 'Large Lorry 17ft'],
};

function coordinate(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedDeliveryMode(deliveryMode) {
  const mode = String(deliveryMode || 'Regular').trim().toLowerCase();
  if (mode === 'priority') return 'priority';
  if (mode === 'pooling') return 'pooling';
  return 'regular';
}

function coordinatesFromAddresses(pickupAddress, deliveryAddress) {
  const pickupLat = coordinate(pickupAddress?.latitude);
  const pickupLng = coordinate(pickupAddress?.longitude);
  const deliveryLat = coordinate(deliveryAddress?.latitude);
  const deliveryLng = coordinate(deliveryAddress?.longitude);
  if (pickupLat == null || pickupLng == null || deliveryLat == null || deliveryLng == null) {
    const err = new Error('Valid pickup and delivery coordinates are required');
    err.statusCode = 400;
    throw err;
  }
  return { pickupLat, pickupLng, deliveryLat, deliveryLng };
}

async function vehiclePricing(db, vehicleType, deliveryMode) {
  const fallbackType = VEHICLE_RATE_PER_KM[vehicleType] ? vehicleType : 'CAR';
  const nameCandidates = VEHICLE_NAME_CANDIDATES[fallbackType] || [fallbackType];
  const vehicle = await db.vehicle.findFirst({
    where: {
      OR: [
        { id: vehicleType },
        { name: { in: nameCandidates } },
        { iconName: String(fallbackType).toLowerCase() },
      ],
    },
    select: { basePrice: true, pricePerKm: true },
  });
  const mode = normalizedDeliveryMode(deliveryMode);
  const configuredRate = VEHICLE_RATE_PER_KM[fallbackType]?.[mode] || VEHICLE_RATE_PER_KM.CAR.regular;
  return {
    vehicleType: fallbackType,
    basePrice: money(vehicle?.basePrice || 0),
    pricePerKm: money(vehicle?.pricePerKm || configuredRate),
  };
}

async function resolveRoute(routeProvider, coords) {
  try {
    const route = await routeProvider.calculateRoute(
      coords.pickupLat,
      coords.pickupLng,
      coords.deliveryLat,
      coords.deliveryLng
    );
    if (route && Number(route.distance) > 0) {
      return {
        distance: money(route.distance),
        duration: Math.max(0, Number(route.duration) || 0),
        isEstimated: !!route.isEstimated,
      };
    }
  } catch (err) {
    console.warn('[pricing] route provider failed, using fallback:', err.message);
  }

  const fallback = routeProvider.fallbackRouteDistance(
    coords.pickupLat,
    coords.pickupLng,
    coords.deliveryLat,
    coords.deliveryLng
  );
  return {
    distance: money(fallback.distance),
    duration: Math.max(0, Number(fallback.duration) || 0),
    isEstimated: true,
  };
}

async function quoteBookingFare({
  pickupAddress,
  deliveryAddress,
  vehicleType,
  deliveryMode,
  db = prisma,
  routeProvider = locationProvider,
}) {
  const coords = coordinatesFromAddresses(pickupAddress, deliveryAddress);
  const [pricing, route] = await Promise.all([
    vehiclePricing(db, vehicleType, deliveryMode),
    resolveRoute(routeProvider, coords),
  ]);
  const baseFare = money(pricing.basePrice);
  const distanceFare = money(route.distance * pricing.pricePerKm);
  const subtotal = money(baseFare + distanceFare);

  return {
    estimatedPrice: subtotal,
    price: subtotal,
    distance: route.distance,
    duration: route.duration,
    isEstimated: route.isEstimated,
    breakdown: {
      currency: 'MYR',
      vehicleType: pricing.vehicleType,
      basePrice: baseFare,
      distance: route.distance,
      pricePerKm: pricing.pricePerKm,
      distanceFare,
      tax: 0,
      total: subtotal,
    },
  };
}

module.exports = {
  quoteBookingFare,
  normalizedDeliveryMode,
  coordinatesFromAddresses,
};
