const express = require('express');
const { authenticate, authenticateToken } = require('../middleware/auth');
const { authenticateDriver, requireDriver } = require('../middleware/driverAuth');
const prisma = require('../lib/prisma');
const location = require('../services/locationProvider');
const { ACTIVE_TRACKING_STATUSES, broadcastDriverLocation } = require('../services/liveTracking');

const router = express.Router();

// GET /api/location/search-places?query=...&lat=...&lng=...
router.get('/search-places', async (req, res, next) => {
  try {
    console.log(`[location] GET /search-places — query="${req.query.query}" lat=${req.query.lat} lng=${req.query.lng}`);
    const { query, lat, lng } = req.query;
    if (!query) {
      return res.status(400).json({ success: false, message: 'query parameter is required' });
    }

    const results = await location.searchPlaces(query, lat, lng);
    console.log(`[location]   → ${results.length} results`);
    res.json({ success: true, data: results });
  } catch (err) {
    next(err);
  }
});

// GET /api/location/reverse-geocode?lat=...&lng=...
router.get('/reverse-geocode', async (req, res, next) => {
  try {
    console.log(`[location] GET /reverse-geocode — lat=${req.query.lat} lng=${req.query.lng}`);
    const { lat, lng } = req.query;
    if (!lat || !lng) {
      return res.status(400).json({ success: false, message: 'lat and lng parameters are required' });
    }

    const data = await location.reverseGeocode(lat, lng);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// POST /api/location/calculate-route
router.post('/calculate-route', authenticateToken, async (req, res, next) => {
  try {
    console.log(`[location] POST /calculate-route — origin=(${req.body.originLat},${req.body.originLng}) dest=(${req.body.destLat},${req.body.destLng})`);
    const { originLat, originLng, destLat, destLng } = req.body;
    if (originLat == null || originLng == null || destLat == null || destLng == null) {
      return res.status(400).json({ success: false, message: 'originLat, originLng, destLat, destLng are required' });
    }

    const origin = { lat: parseFloat(originLat), lng: parseFloat(originLng) };
    const dest = { lat: parseFloat(destLat), lng: parseFloat(destLng) };
    if (
      !Number.isFinite(origin.lat) || !Number.isFinite(origin.lng) ||
      !Number.isFinite(dest.lat) || !Number.isFinite(dest.lng)
    ) {
      return res.status(400).json({ success: false, message: 'Valid coordinates are required' });
    }

    const data = await location.calculateRoute(origin.lat, origin.lng, dest.lat, dest.lng);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// GET /api/location/map-config
router.get('/map-config', authenticateToken, async (req, res) => {
  console.log(`[location] GET /map-config`);
  res.json({
    success: true,
    data: {
      apiKey: location.GOOGLE_MAPS_API_KEY,
      styleUrl: '',
      region: '',
    },
  });
});

// POST /api/location/update-position
router.post('/update-position', authenticateDriver, requireDriver, async (req, res, next) => {
  try {
    const { latitude, longitude } = req.body;
    const lat = Number(latitude);
    const lng = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ success: false, message: 'Valid latitude and longitude are required' });
    }

    await prisma.driver.update({
      where: { id: req.driver.id },
      data: { currentLatitude: lat, currentLongitude: lng },
    });

    const activeBookings = await prisma.booking.findMany({
      where: {
        driverId: req.driver.id,
        status: { in: ACTIVE_TRACKING_STATUSES },
      },
      select: { id: true },
    });
    const timestamp = new Date().toISOString();
    activeBookings.forEach((booking) => {
      broadcastDriverLocation(booking.id, { latitude: lat, longitude: lng, timestamp });
    });

    res.json({ success: true, message: 'Position updated', data: { activeBookings: activeBookings.length } });
  } catch (err) {
    next(err);
  }
});

// GET /api/location/get-position/:deviceId
router.get('/get-position/:deviceId', authenticate, async (req, res, next) => {
  try {
    const { deviceId } = req.params;
    const allowedBooking = await prisma.booking.findFirst({
      where: {
        userId: req.user.userId,
        driverId: deviceId,
        status: { in: ['DRIVER_ASSIGNED', 'DRIVER_ARRIVED', 'PICKUP_DONE', 'IN_TRANSIT', 'ARRIVED_AT_DROP'] },
      },
      select: { id: true },
    });
    if (!allowedBooking) {
      return res.status(403).json({ success: false, message: 'Not authorized to view this driver location' });
    }

    const driver = await prisma.driver.findUnique({
      where: { id: deviceId },
      select: { currentLatitude: true, currentLongitude: true, createdAt: true },
    });

    res.json({
      success: true,
      data: {
        deviceId,
        latitude: driver?.currentLatitude ?? 0,
        longitude: driver?.currentLongitude ?? 0,
        timestamp: driver?.createdAt?.toISOString() ?? '',
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/location/autocomplete?query=...&lat=...&lng=...
router.get('/autocomplete', async (req, res, next) => {
  try {
    console.log(`[location] GET /autocomplete — query="${req.query.query}" lat=${req.query.lat} lng=${req.query.lng}`);
    const { query, lat, lng } = req.query;
    if (!query) {
      return res.status(400).json({ success: false, message: 'query parameter is required' });
    }

    const results = await location.autocomplete(query, lat, lng);
    res.json({ success: true, data: results });
  } catch (err) {
    next(err);
  }
});

// GET /api/location/nearby?lat=...&lng=...&categories=...&radius=...
router.get('/nearby', authenticateToken, async (req, res, next) => {
  try {
    console.log(`[location] GET /nearby — lat=${req.query.lat} lng=${req.query.lng} categories=${req.query.categories} radius=${req.query.radius}`);
    const { lat, lng, categories, radius } = req.query;
    if (!lat || !lng) {
      return res.status(400).json({ success: false, message: 'lat and lng parameters are required' });
    }

    const results = await location.searchNearby(lat, lng, categories, radius);
    res.json({ success: true, data: results });
  } catch (err) {
    next(err);
  }
});

// POST /api/location/geocode
router.post('/geocode', authenticateToken, async (req, res, next) => {
  try {
    const { address, placeId } = req.body;
    console.log(`[location] POST /geocode — address="${address}" placeId="${placeId}"`);

    if (!address && !placeId) {
      return res.status(400).json({ success: false, message: 'address or placeId is required' });
    }

    const data = await location.geocode({ address, placeId });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// POST /api/location/snap-to-roads
router.post('/snap-to-roads', authenticateToken, async (req, res, next) => {
  try {
    console.log(`[location] POST /snap-to-roads — ${req.body.points?.length || 0} points`);
    const { points } = req.body;
    if (!points || !Array.isArray(points) || points.length < 2) {
      return res.status(400).json({ success: false, message: 'points array with at least 2 items is required' });
    }

    const snappedPoints = await location.snapToRoads(points);
    res.json({ success: true, data: { snappedPoints } });
  } catch (err) {
    next(err);
  }
});

// POST /api/location/isoline
router.post('/isoline', authenticateToken, async (req, res, next) => {
  try {
    console.log(`[location] POST /isoline — lat=${req.body.lat} lng=${req.body.lng} minutes=${req.body.minutes}`);
    const { lat, lng, minutes } = req.body;
    if (lat == null || lng == null || !minutes) {
      return res.status(400).json({ success: false, message: 'lat, lng, and minutes are required' });
    }

    const data = location.buildIsolinePolygon(lat, lng, minutes);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// GET /api/location/static-map
router.get('/static-map', authenticateToken, async (req, res) => {
  console.log(`[location] GET /static-map — lat=${req.query.lat} lng=${req.query.lng} zoom=${req.query.zoom} ${req.query.width}x${req.query.height}`);
  const { lat, lng, zoom = 13, width = 400, height = 300 } = req.query;
  if (!lat || !lng) {
    return res.status(400).json({ success: false, message: 'lat and lng parameters are required' });
  }

  const url = location.buildStaticMapUrl(lat, lng, zoom, width, height);
  res.json({ success: true, data: { url } });
});

// POST /api/location/route-matrix
router.post('/route-matrix', authenticateToken, async (req, res, next) => {
  try {
    console.log(`[location] POST /route-matrix — ${req.body.origins?.length || 0} origins, ${req.body.destinations?.length || 0} destinations`);
    const { origins, destinations } = req.body;
    if (!origins?.length || !destinations?.length) {
      return res.status(400).json({ success: false, message: 'origins and destinations arrays are required' });
    }

    const matrix = await location.routeMatrix(origins, destinations);
    res.json({ success: true, data: matrix });
  } catch (err) {
    next(err);
  }
});

// POST /api/location/optimize-waypoints
router.post('/optimize-waypoints', authenticateToken, async (req, res, next) => {
  try {
    console.log(`[location] POST /optimize-waypoints — ${req.body.waypoints?.length || 0} waypoints`);
    const { origin, destination, waypoints } = req.body;
    if (!origin || !destination || !waypoints?.length) {
      return res.status(400).json({ success: false, message: 'origin, destination, and waypoints are required' });
    }

    const data = await location.optimizeWaypoints(origin, destination, waypoints);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
