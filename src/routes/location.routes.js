const express = require('express');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

const API_KEY = process.env.AWS_MAP_API_KEY || '';
const REGION = process.env.AWS_REGION || 'us-east-1';

// Helper: make AWS Location v2 REST API call using API key
async function awsLocationFetch(subdomain, path, method = 'POST', body = null) {
  const separator = path.includes('?') ? '&' : '?';
  const url = `https://${subdomain}.geo.${REGION}.amazonaws.com${path}${separator}key=${API_KEY}`;
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }

  const start = Date.now();
  console.log(`[AWS Location] → ${method} ${subdomain}.geo.${REGION}.amazonaws.com${path}`);
  if (body) {
    console.log(`[AWS Location]   body: ${JSON.stringify(body)}`);
  }

  const response = await fetch(url, options);
  const elapsed = Date.now() - start;

  if (!response.ok) {
    const errText = await response.text();
    console.error(`[AWS Location] ✗ ${method} ${path} — ${response.status} (${elapsed}ms): ${errText}`);
    const err = new Error(`AWS Location API error (${response.status}): ${errText}`);
    err.statusCode = response.status;
    throw err;
  }

  console.log(`[AWS Location] ✓ ${method} ${path} — ${response.status} (${elapsed}ms)`);

  // Some endpoints (static-map) return binary — handle gracefully
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response;
}

// ──────────────────────────────────────────────────────────────
// EXISTING ENDPOINTS — migrated to v2
// ──────────────────────────────────────────────────────────────

// GET /api/location/search-places?query=...&lat=...&lng=...
router.get('/search-places', authenticate, async (req, res, next) => {
  try {
    console.log(`[location] GET /search-places — query="${req.query.query}" lat=${req.query.lat} lng=${req.query.lng}`);
    const { query, lat, lng } = req.query;
    if (!query) {
      return res.status(400).json({ success: false, message: 'query parameter is required' });
    }

    const body = {
      QueryText: query,
      MaxResults: 10,
    };
    if (lat && lng) {
      body.BiasPosition = [parseFloat(lng), parseFloat(lat)];
    }

    const response = await awsLocationFetch('places', '/v2/search-text', 'POST', body);

    const results = (response.ResultItems || []).map((r) => ({
      placeId: r.PlaceId || '',
      label: r.Title || '',
      address: r.Address?.Label || '',
      city: r.Address?.Municipality || '',
      region: r.Address?.Region || '',
      country: r.Address?.Country || '',
      latitude: r.Position?.[1] || 0,
      longitude: r.Position?.[0] || 0,
    }));

    res.json({ success: true, data: results });
  } catch (err) {
    next(err);
  }
});

// GET /api/location/reverse-geocode?lat=...&lng=...
router.get('/reverse-geocode', authenticate, async (req, res, next) => {
  try {
    console.log(`[location] GET /reverse-geocode — lat=${req.query.lat} lng=${req.query.lng}`);
    const { lat, lng } = req.query;
    if (!lat || !lng) {
      return res.status(400).json({ success: false, message: 'lat and lng parameters are required' });
    }

    const response = await awsLocationFetch('places', '/v2/reverse-geocode', 'POST', {
      QueryPosition: [parseFloat(lng), parseFloat(lat)],
      MaxResults: 1,
    });

    const r = response.ResultItems?.[0];
    if (!r) {
      return res.json({ success: true, data: null });
    }

    res.json({
      success: true,
      data: {
        placeId: r.PlaceId || '',
        label: r.Title || '',
        address: r.Address?.Label || '',
        city: r.Address?.Municipality || '',
        region: r.Address?.Region || '',
        country: r.Address?.Country || '',
        latitude: r.Position?.[1] || 0,
        longitude: r.Position?.[0] || 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/location/calculate-route
// Body: { originLat, originLng, destLat, destLng }
router.post('/calculate-route', authenticate, async (req, res, next) => {
  try {
    console.log(`[location] POST /calculate-route — origin=(${req.body.originLat},${req.body.originLng}) dest=(${req.body.destLat},${req.body.destLng})`);
    const { originLat, originLng, destLat, destLng } = req.body;
    if (originLat == null || originLng == null || destLat == null || destLng == null) {
      return res.status(400).json({ success: false, message: 'originLat, originLng, destLat, destLng are required' });
    }

    const response = await awsLocationFetch('routes', '/v2/routes', 'POST', {
      Origin: [parseFloat(originLng), parseFloat(originLat)],
      Destination: [parseFloat(destLng), parseFloat(destLat)],
      TravelMode: 'Car',
      LegGeometryFormat: 'Simple',
    });

    // v2 response: { Legs: [{ Geometry: { LineString: [[lng,lat],...] }, TravelStepSummary, ... }], Summary: { Distance, Duration } }
    const summary = response.Summary || {};
    const legs = response.Legs || [];

    const geometry = [];
    for (const leg of legs) {
      const points = leg.Geometry?.LineString || [];
      for (const point of points) {
        geometry.push({ lat: point[1], lng: point[0] });
      }
    }

    res.json({
      success: true,
      data: {
        distance: Math.round((summary.Distance || 0) / 1000 * 100) / 100, // meters → km
        duration: Math.round((summary.Duration || 0) / 60), // seconds → minutes
        geometry,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/location/map-config
router.get('/map-config', authenticate, async (req, res) => {
  console.log(`[location] GET /map-config — region=${REGION}`);
  const styleUrl = `https://maps.geo.${REGION}.amazonaws.com/v2/styles/Standard/descriptor?key=${API_KEY}`;
  res.json({
    success: true,
    data: {
      apiKey: API_KEY,
      styleUrl,
      region: REGION,
    },
  });
});

// POST /api/location/update-position
// Body: { deviceId, latitude, longitude }
// Note: Tracker is a v1 resource — keeping as-is if a tracker is configured.
// For apps without a tracker, this is a no-op stub.
router.post('/update-position', authenticate, async (req, res, next) => {
  try {
    console.log(`[location] POST /update-position — deviceId="${req.body.deviceId}" lat=${req.body.latitude} lng=${req.body.longitude}`);
    const { deviceId, latitude, longitude } = req.body;
    if (!deviceId || latitude == null || longitude == null) {
      return res.status(400).json({ success: false, message: 'deviceId, latitude, longitude are required' });
    }
    // In production, persist to your own DB or use AWS Tracker if configured
    res.json({ success: true, message: 'Position updated' });
  } catch (err) {
    next(err);
  }
});

// GET /api/location/get-position/:deviceId
router.get('/get-position/:deviceId', authenticate, async (req, res, next) => {
  try {
    console.log(`[location] GET /get-position — deviceId="${req.params.deviceId}"`);
    const { deviceId } = req.params;
    // Stub — in production, read from your DB or tracker
    res.json({
      success: true,
      data: {
        deviceId,
        latitude: 0,
        longitude: 0,
        timestamp: '',
      },
    });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────
// NEW v2 ENDPOINTS
// ──────────────────────────────────────────────────────────────

// GET /api/location/autocomplete?query=...&lat=...&lng=...
router.get('/autocomplete', authenticate, async (req, res, next) => {
  try {
    console.log(`[location] GET /autocomplete — query="${req.query.query}" lat=${req.query.lat} lng=${req.query.lng}`);
    const { query, lat, lng } = req.query;
    if (!query) {
      return res.status(400).json({ success: false, message: 'query parameter is required' });
    }

    const body = { QueryText: query, MaxResults: 7 };
    if (lat && lng) {
      body.BiasPosition = [parseFloat(lng), parseFloat(lat)];
    }

    const response = await awsLocationFetch('places', '/v2/autocomplete', 'POST', body);

    const results = (response.ResultItems || []).map((r) => ({
      placeId: r.PlaceId || '',
      title: r.Title || '',
      address: r.Address?.Label || '',
      highlights: (r.Highlights || []).map((h) => ({
        start: h.StartIndex || 0,
        end: h.EndIndex || 0,
      })),
    }));

    res.json({ success: true, data: results });
  } catch (err) {
    next(err);
  }
});

// GET /api/location/nearby?lat=...&lng=...&categories=...&radius=...
router.get('/nearby', authenticate, async (req, res, next) => {
  try {
    console.log(`[location] GET /nearby — lat=${req.query.lat} lng=${req.query.lng} categories=${req.query.categories} radius=${req.query.radius}`);
    const { lat, lng, categories, radius } = req.query;
    if (!lat || !lng) {
      return res.status(400).json({ success: false, message: 'lat and lng parameters are required' });
    }

    const body = {
      QueryPosition: [parseFloat(lng), parseFloat(lat)],
      MaxResults: 15,
    };
    if (radius) {
      body.QueryRadius = parseInt(radius, 10);
    }
    if (categories) {
      body.Filter = { Categories: categories.split(',') };
    }

    const response = await awsLocationFetch('places', '/v2/search-nearby', 'POST', body);

    const results = (response.ResultItems || []).map((r) => ({
      placeId: r.PlaceId || '',
      title: r.Title || '',
      address: r.Address?.Label || '',
      categories: r.Categories || [],
      distance: r.Distance || 0,
      lat: r.Position?.[1] || 0,
      lng: r.Position?.[0] || 0,
    }));

    res.json({ success: true, data: results });
  } catch (err) {
    next(err);
  }
});

// POST /api/location/geocode
// Body: { address }
router.post('/geocode', authenticate, async (req, res, next) => {
  try {
    console.log(`[location] POST /geocode — address="${req.body.address}"`);
    const { address } = req.body;
    if (!address) {
      return res.status(400).json({ success: false, message: 'address is required' });
    }

    const response = await awsLocationFetch('places', '/v2/geocode', 'POST', {
      QueryText: address,
      MaxResults: 1,
    });

    const r = response.ResultItems?.[0];
    if (!r) {
      return res.json({ success: true, data: null });
    }

    res.json({
      success: true,
      data: {
        placeId: r.PlaceId || '',
        title: r.Title || '',
        lat: r.Position?.[1] || 0,
        lng: r.Position?.[0] || 0,
        address: r.Address?.Label || '',
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/location/snap-to-roads
// Body: { points: [{lat, lng}, ...] }
router.post('/snap-to-roads', authenticate, async (req, res, next) => {
  try {
    console.log(`[location] POST /snap-to-roads — ${req.body.points?.length || 0} points`);
    const { points } = req.body;
    if (!points || !Array.isArray(points) || points.length < 2) {
      return res.status(400).json({ success: false, message: 'points array with at least 2 items is required' });
    }

    const tracePoints = points.map((p) => ({
      Position: [p.lng, p.lat],
    }));

    const response = await awsLocationFetch('routes', '/v2/snap-to-roads', 'POST', {
      TracePoints: tracePoints,
    });

    const snappedPoints = (response.SnappedGeometry?.LineString || []).map((p) => ({
      lat: p[1],
      lng: p[0],
    }));

    res.json({ success: true, data: { snappedPoints } });
  } catch (err) {
    next(err);
  }
});

// POST /api/location/isoline
// Body: { lat, lng, minutes }
router.post('/isoline', authenticate, async (req, res, next) => {
  try {
    console.log(`[location] POST /isoline — lat=${req.body.lat} lng=${req.body.lng} minutes=${req.body.minutes}`);
    const { lat, lng, minutes } = req.body;
    if (lat == null || lng == null || !minutes) {
      return res.status(400).json({ success: false, message: 'lat, lng, and minutes are required' });
    }

    const response = await awsLocationFetch('routes', '/v2/isolines', 'POST', {
      Origin: [parseFloat(lng), parseFloat(lat)],
      Thresholds: {
        Time: [parseInt(minutes, 10) * 60], // minutes → seconds
      },
      TravelMode: 'Car',
    });

    const isoline = response.Isolines?.[0];
    if (!isoline) {
      return res.json({ success: true, data: null });
    }

    const polygon = (isoline.Geometries?.[0]?.Polygon?.[0] || []).map((p) => ({
      lat: p[1],
      lng: p[0],
    }));

    res.json({
      success: true,
      data: {
        geometry: polygon,
        distanceMeters: isoline.Distance || 0,
        durationSeconds: isoline.Duration || 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/location/static-map?lat=...&lng=...&zoom=...&width=...&height=...
router.get('/static-map', authenticate, async (req, res) => {
  console.log(`[location] GET /static-map — lat=${req.query.lat} lng=${req.query.lng} zoom=${req.query.zoom} ${req.query.width}x${req.query.height}`);
  const { lat, lng, zoom = 13, width = 400, height = 300 } = req.query;
  if (!lat || !lng) {
    return res.status(400).json({ success: false, message: 'lat and lng parameters are required' });
  }

  const staticMapUrl =
    `https://maps.geo.${REGION}.amazonaws.com/v2/static-maps/Standard/map.png` +
    `?center=${lng},${lat}&zoom=${zoom}&width=${width}&height=${height}&key=${API_KEY}`;

  res.json({
    success: true,
    data: { url: staticMapUrl },
  });
});

// ──────────────────────────────────────────────────────────────
// BACKEND-ONLY ENDPOINTS (not wired to screens yet)
// ──────────────────────────────────────────────────────────────

// POST /api/location/route-matrix
// Body: { origins: [{lat,lng},...], destinations: [{lat,lng},...] }
router.post('/route-matrix', authenticate, async (req, res, next) => {
  try {
    console.log(`[location] POST /route-matrix — ${req.body.origins?.length || 0} origins, ${req.body.destinations?.length || 0} destinations`);
    const { origins, destinations } = req.body;
    if (!origins?.length || !destinations?.length) {
      return res.status(400).json({ success: false, message: 'origins and destinations arrays are required' });
    }

    const response = await awsLocationFetch('routes', '/v2/route-matrix', 'POST', {
      Origins: origins.map((o) => ({ Position: [o.lng, o.lat] })),
      Destinations: destinations.map((d) => ({ Position: [d.lng, d.lat] })),
      TravelMode: 'Car',
    });

    res.json({ success: true, data: response.RouteMatrix || [] });
  } catch (err) {
    next(err);
  }
});

// POST /api/location/optimize-waypoints
// Body: { origin: {lat,lng}, destination: {lat,lng}, waypoints: [{lat,lng},...] }
router.post('/optimize-waypoints', authenticate, async (req, res, next) => {
  try {
    console.log(`[location] POST /optimize-waypoints — ${req.body.waypoints?.length || 0} waypoints`);
    const { origin, destination, waypoints } = req.body;
    if (!origin || !destination || !waypoints?.length) {
      return res.status(400).json({ success: false, message: 'origin, destination, and waypoints are required' });
    }

    const response = await awsLocationFetch('routes', '/v2/optimize-waypoints', 'POST', {
      Origin: [origin.lng, origin.lat],
      Destination: [destination.lng, destination.lat],
      Waypoints: waypoints.map((w) => ({ Position: [w.lng, w.lat] })),
      TravelMode: 'Car',
    });

    res.json({
      success: true,
      data: {
        optimizedWaypoints: (response.OptimizedWaypoints || []).map((w) => ({
          position: { lat: w.Position?.[1], lng: w.Position?.[0] },
          originalIndex: w.OriginalIndex,
        })),
        distance: response.Distance || 0,
        duration: response.Duration || 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
