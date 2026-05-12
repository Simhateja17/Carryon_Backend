// ── Geo-Fence Service ──────────────────────────────────────
// Determines whether a lat/lng point falls inside any enabled
// service region. Uses circle-based geo-fences with haversine
// distance and an in-memory cache to avoid DB reads per request.

const { haversineKm } = require('../lib/distance');
const { getAdminSetting, FLEET_SETTINGS_KEY, DEFAULT_FLEET_SETTINGS } = require('./adminSettings');

const CACHE_TTL_MS = 60_000;

let cachedRegions = null;
let cacheExpiry = 0;

function clearGeoFenceCache() {
  cachedRegions = null;
  cacheExpiry = 0;
}

async function getEnabledGeoFences() {
  const now = Date.now();
  if (cachedRegions && now < cacheExpiry) return cachedRegions;

  const settings = await getAdminSetting(FLEET_SETTINGS_KEY, DEFAULT_FLEET_SETTINGS);
  const regions = (settings.regions || []).filter(
    (r) =>
      r.enabled === true &&
      Number.isFinite(r.latitude) &&
      Number.isFinite(r.longitude) &&
      Number.isFinite(r.radiusKm) &&
      r.radiusKm > 0
  );

  cachedRegions = regions;
  cacheExpiry = now + CACHE_TTL_MS;
  return regions;
}

async function isPointInServiceArea(lat, lng) {
  const regions = await getEnabledGeoFences();

  // If no geo-fenced regions are configured, allow everything (graceful degradation)
  if (regions.length === 0) {
    return { allowed: true, region: null };
  }

  for (const region of regions) {
    const distance = haversineKm(lat, lng, region.latitude, region.longitude);
    if (distance <= region.radiusKm) {
      return { allowed: true, region };
    }
  }

  return { allowed: false, region: null };
}

async function validateBookingLocations(pickupCoords, deliveryCoords) {
  const [pickupCheck, deliveryCheck] = await Promise.all([
    isPointInServiceArea(pickupCoords.latitude, pickupCoords.longitude),
    isPointInServiceArea(deliveryCoords.latitude, deliveryCoords.longitude),
  ]);
  if (!pickupCheck.allowed) return { valid: false, error: 'Service is not available at the pickup location.' };
  if (!deliveryCheck.allowed) return { valid: false, error: 'Service is not available at the delivery location.' };
  return { valid: true, error: null, pickupRegion: pickupCheck.region, deliveryRegion: deliveryCheck.region };
}

async function validateOptionalBookingLocations(pickupCoords, deliveryCoords) {
  if (pickupCoords) {
    const check = await isPointInServiceArea(pickupCoords.latitude, pickupCoords.longitude);
    if (!check.allowed) return { valid: false, error: 'Service is not available at the pickup location.' };
  }
  if (deliveryCoords) {
    const check = await isPointInServiceArea(deliveryCoords.latitude, deliveryCoords.longitude);
    if (!check.allowed) return { valid: false, error: 'Service is not available at the delivery location.' };
  }
  return { valid: true, error: null };
}

async function assertDriverInServiceArea(lat, lng) {
  const check = await isPointInServiceArea(lat, lng);
  if (!check.allowed) {
    const err = new Error('You are outside the service area. Move to an active region to go online.');
    err.statusCode = 403;
    throw err;
  }
  return check;
}

module.exports = {
  isPointInServiceArea,
  getEnabledGeoFences,
  clearGeoFenceCache,
  validateBookingLocations,
  validateOptionalBookingLocations,
  assertDriverInServiceArea,
};
