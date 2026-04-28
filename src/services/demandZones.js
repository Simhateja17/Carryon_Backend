const prisma = require('../lib/prisma');

const ACTIVE_DEMAND_STATUSES = ['SEARCHING_DRIVER', 'PENDING'];
const DEFAULT_RADIUS_KM = 10;
const MAX_RADIUS_KM = 50;
const EARTH_RADIUS_KM = 6371;

function toRad(value) {
  return value * Math.PI / 180;
}

function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

function normalizeRadiusKm(radiusKm) {
  const parsed = Number(radiusKm);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RADIUS_KM;
  return Math.min(parsed, MAX_RADIUS_KM);
}

function normalizeVehicleType(vehicleType) {
  return String(vehicleType || '').trim().toUpperCase();
}

function zoneKey(lat, lng) {
  return `${lat.toFixed(2)}:${lng.toFixed(2)}`;
}

function buildZone(center, bookings, onlineDrivers) {
  const driverCount = onlineDrivers.filter((driver) => (
    haversineKm(center, { lat: driver.currentLatitude, lng: driver.currentLongitude }) <= 3
  )).length;
  const demandCount = bookings.length;
  const score = demandCount / Math.max(1, driverCount);
  const level = score >= 3 ? 'HIGH' : score >= 1.5 ? 'MEDIUM' : 'LOW';

  return {
    id: zoneKey(center.lat, center.lng),
    centerLatitude: center.lat,
    centerLongitude: center.lng,
    radiusKm: 3,
    demandCount,
    onlineDriverCount: driverCount,
    score,
    level,
    guidance: level === 'HIGH'
      ? 'High demand nearby. Move closer to this area for better job availability.'
      : level === 'MEDIUM'
        ? 'Moderate demand nearby.'
        : 'Low demand nearby.',
  };
}

async function computeDemandZones({ lat, lng, radiusKm, vehicleType }) {
  const center = { lat: Number(lat), lng: Number(lng) };
  if (!Number.isFinite(center.lat) || !Number.isFinite(center.lng)) {
    const err = new Error('lat and lng query parameters are required');
    err.statusCode = 400;
    throw err;
  }

  const searchRadiusKm = normalizeRadiusKm(radiusKm);
  const normalizedVehicleType = normalizeVehicleType(vehicleType);

  const [bookings, onlineDrivers] = await Promise.all([
    prisma.booking.findMany({
      where: {
        status: { in: ACTIVE_DEMAND_STATUSES },
        ...(normalizedVehicleType && { vehicleType: normalizedVehicleType }),
      },
      include: { pickupAddress: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    prisma.driver.findMany({
      where: { isOnline: true, isVerified: true },
      include: { vehicle: true },
      take: 500,
    }),
  ]);

  const nearbyBookings = bookings.filter((booking) => {
    const pickup = {
      lat: booking.pickupAddress?.latitude || 0,
      lng: booking.pickupAddress?.longitude || 0,
    };
    return haversineKm(center, pickup) <= searchRadiusKm;
  });

  const nearbyDrivers = onlineDrivers.filter((driver) => {
    if (normalizedVehicleType && normalizeVehicleType(driver.vehicle?.type) !== normalizedVehicleType) {
      return false;
    }
    return haversineKm(center, {
      lat: driver.currentLatitude || 0,
      lng: driver.currentLongitude || 0,
    }) <= searchRadiusKm;
  });

  const buckets = new Map();
  for (const booking of nearbyBookings) {
    const pickup = {
      lat: booking.pickupAddress.latitude,
      lng: booking.pickupAddress.longitude,
    };
    const key = zoneKey(pickup.lat, pickup.lng);
    const current = buckets.get(key) || { center: pickup, bookings: [] };
    current.bookings.push(booking);
    buckets.set(key, current);
  }

  const zones = Array.from(buckets.values())
    .map((bucket) => buildZone(bucket.center, bucket.bookings, nearbyDrivers))
    .filter((zone) => zone.demandCount > 0)
    .sort((a, b) => b.score - a.score || b.demandCount - a.demandCount)
    .slice(0, 10);

  return {
    centerLatitude: center.lat,
    centerLongitude: center.lng,
    radiusKm: searchRadiusKm,
    vehicleType: normalizedVehicleType || null,
    zones,
  };
}

module.exports = {
  computeDemandZones,
  haversineKm,
  normalizeRadiusKm,
};
