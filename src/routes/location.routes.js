const express = require('express');
const { authenticate } = require('../middleware/auth');
const prisma = require('../lib/prisma');

const router = express.Router();

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

// Helper: make Google Maps API call
async function googleMapsFetch(url, method = 'GET', body = null, headers = {}) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }

  const start = Date.now();
  console.log(`[Google Maps] → ${method} ${url.replace(GOOGLE_MAPS_API_KEY, '***')}`);
  if (body) {
    console.log(`[Google Maps]   body: ${JSON.stringify(body)}`);
  }

  const response = await fetch(url, options);
  const elapsed = Date.now() - start;

  if (!response.ok) {
    const errText = await response.text();
    console.error(`[Google Maps] ✗ ${method} — ${response.status} (${elapsed}ms): ${errText}`);
    const err = new Error(`Google Maps API error (${response.status}): ${errText}`);
    err.statusCode = response.status;
    throw err;
  }

  console.log(`[Google Maps] ✓ ${method} — ${response.status} (${elapsed}ms)`);

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response;
}

// ──────────────────────────────────────────────────────────────
// PLACES ENDPOINTS — using Google Places API (New)
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
      textQuery: query,
      maxResultCount: 10,
    };
    if (lat && lng) {
      body.locationBias = {
        circle: {
          center: { latitude: parseFloat(lat), longitude: parseFloat(lng) },
          radius: 50000.0,
        },
      };
    }

    const response = await googleMapsFetch(
      'https://places.googleapis.com/v1/places:searchText',
      'POST',
      body,
      {
        'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.addressComponents',
      }
    );

    const results = (response.places || []).map((p) => ({
      placeId: p.id || '',
      label: p.displayName?.text || '',
      address: p.formattedAddress || '',
      city: (p.addressComponents || []).find((c) => (c.types || []).includes('locality'))?.longText || '',
      region: (p.addressComponents || []).find((c) => (c.types || []).includes('administrative_area_level_1'))?.longText || '',
      country: (p.addressComponents || []).find((c) => (c.types || []).includes('country'))?.longText || '',
      latitude: p.location?.latitude || 0,
      longitude: p.location?.longitude || 0,
    }));

    console.log(`[location]   → ${results.length} results`);
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

    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${GOOGLE_MAPS_API_KEY}`;
    const response = await googleMapsFetch(url);

    if (response.status !== 'OK') {
      console.warn(`[location] /reverse-geocode — non-OK status: ${response.status} (error_message: ${response.error_message || 'none'})`);
      return res.json({ success: true, data: null });
    }

    const r = response.results?.[0];
    if (!r) {
      return res.json({ success: true, data: null });
    }

    const components = r.address_components || [];
    res.json({
      success: true,
      data: {
        placeId: r.place_id || '',
        label: r.formatted_address || '',
        address: r.formatted_address || '',
        city: components.find((c) => c.types?.includes('locality'))?.long_name || '',
        region: components.find((c) => c.types?.includes('administrative_area_level_1'))?.long_name || '',
        country: components.find((c) => c.types?.includes('country'))?.long_name || '',
        latitude: r.geometry?.location?.lat || 0,
        longitude: r.geometry?.location?.lng || 0,
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

    const response = await googleMapsFetch(
      'https://routes.googleapis.com/directions/v2:computeRoutes',
      'POST',
      {
        origin: { location: { latLng: { latitude: parseFloat(originLat), longitude: parseFloat(originLng) } } },
        destination: { location: { latLng: { latitude: parseFloat(destLat), longitude: parseFloat(destLng) } } },
        travelMode: 'DRIVE',
        polylineEncoding: 'GEO_JSON_LINESTRING',
      },
      {
        'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline',
      }
    );

    const route = response.routes?.[0] || {};
    const distanceMeters = route.distanceMeters || 0;
    const durationSeconds = parseInt((route.duration || '0s').replace('s', ''), 10);

    // Debug: log what polyline keys were returned
    const polylineKeys = Object.keys(route.polyline || {});
    console.log(`[location] /calculate-route — polyline keys: [${polylineKeys.join(', ')}]`);

    // Parse GeoJSON LineString geometry
    const geometry = [];
    const coords = route.polyline?.geoJsonLinestring?.coordinates || [];
    for (const coord of coords) {
      geometry.push({ lat: coord[1], lng: coord[0] });
    }

    // Fallback: decode encoded polyline if GeoJSON was empty
    if (geometry.length === 0 && route.polyline?.encodedPolyline) {
      console.log(`[location] /calculate-route — falling back to encoded polyline decoder`);
      const encoded = route.polyline.encodedPolyline;
      let index = 0, lat = 0, lng = 0;
      while (index < encoded.length) {
        let shift = 0, result = 0, b;
        do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        lat += (result & 1) ? ~(result >> 1) : (result >> 1);
        shift = 0; result = 0;
        do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        lng += (result & 1) ? ~(result >> 1) : (result >> 1);
        geometry.push({ lat: lat / 1e5, lng: lng / 1e5 });
      }
      console.log(`[location] /calculate-route — decoded ${geometry.length} points from encoded polyline`);
    }

    res.json({
      success: true,
      data: {
        distance: Math.round(distanceMeters / 1000 * 100) / 100, // meters → km
        duration: Math.round(durationSeconds / 60), // seconds → minutes
        geometry,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/location/map-config
router.get('/map-config', authenticate, async (req, res) => {
  console.log(`[location] GET /map-config`);
  res.json({
    success: true,
    data: {
      apiKey: GOOGLE_MAPS_API_KEY,
      styleUrl: '', // Not needed for Google Maps SDK — styling is built-in
      region: '',
    },
  });
});

// POST /api/location/update-position
// Body: { deviceId, latitude, longitude }
// Persists the driver's position to the database
router.post('/update-position', authenticate, async (req, res, next) => {
  try {
    const { deviceId, latitude, longitude } = req.body;
    if (!deviceId || latitude == null || longitude == null) {
      return res.status(400).json({ success: false, message: 'deviceId, latitude, longitude are required' });
    }

    // Try to update driver position in DB
    try {
      await prisma.driver.update({
        where: { id: deviceId },
        data: { currentLatitude: latitude, currentLongitude: longitude },
      });
    } catch (_) {
      // deviceId may not be a driver — ignore
    }

    res.json({ success: true, message: 'Position updated' });
  } catch (err) {
    next(err);
  }
});

// GET /api/location/get-position/:deviceId
// Returns the driver's last known position from the database
router.get('/get-position/:deviceId', authenticate, async (req, res, next) => {
  try {
    const { deviceId } = req.params;

    const driver = await prisma.driver.findUnique({
      where: { id: deviceId },
      select: { currentLatitude: true, currentLongitude: true, updatedAt: true },
    });

    res.json({
      success: true,
      data: {
        deviceId,
        latitude: driver?.currentLatitude ?? 0,
        longitude: driver?.currentLongitude ?? 0,
        timestamp: driver?.updatedAt?.toISOString() ?? '',
      },
    });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────
// v2 ENDPOINTS — using Google Maps Platform
// ──────────────────────────────────────────────────────────────

// GET /api/location/autocomplete?query=...&lat=...&lng=...
router.get('/autocomplete', authenticate, async (req, res, next) => {
  try {
    console.log(`[location] GET /autocomplete — query="${req.query.query}" lat=${req.query.lat} lng=${req.query.lng}`);
    const { query, lat, lng } = req.query;
    if (!query) {
      return res.status(400).json({ success: false, message: 'query parameter is required' });
    }

    const body = { input: query };
    if (lat && lng) {
      body.locationBias = {
        circle: {
          center: { latitude: parseFloat(lat), longitude: parseFloat(lng) },
          radius: 50000.0,
        },
      };
    }

    const response = await googleMapsFetch(
      'https://places.googleapis.com/v1/places:autocomplete',
      'POST',
      body,
      { 'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY }
    );

    const results = (response.suggestions || [])
      .filter((s) => s.placePrediction)
      .map((s) => {
        const p = s.placePrediction;
        return {
          placeId: p.placeId || '',
          title: p.structuredFormat?.mainText?.text || p.text?.text || '',
          address: p.structuredFormat?.secondaryText?.text || '',
          highlights: (p.structuredFormat?.mainText?.matches || []).map((m) => ({
            start: m.startOffset || 0,
            end: m.endOffset || 0,
          })),
        };
      });

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
      locationRestriction: {
        circle: {
          center: { latitude: parseFloat(lat), longitude: parseFloat(lng) },
          radius: radius ? parseFloat(radius) : 5000.0,
        },
      },
      maxResultCount: 15,
    };
    if (categories) {
      body.includedTypes = categories.split(',');
    }

    const response = await googleMapsFetch(
      'https://places.googleapis.com/v1/places:searchNearby',
      'POST',
      body,
      {
        'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.types,places.location',
      }
    );

    const results = (response.places || []).map((p) => ({
      placeId: p.id || '',
      title: p.displayName?.text || '',
      address: p.formattedAddress || '',
      categories: p.types || [],
      distance: 0, // Google Nearby Search doesn't return distance; compute client-side if needed
      lat: p.location?.latitude || 0,
      lng: p.location?.longitude || 0,
    }));

    res.json({ success: true, data: results });
  } catch (err) {
    next(err);
  }
});

// POST /api/location/geocode
// Body: { address } or { placeId }
router.post('/geocode', authenticate, async (req, res, next) => {
  try {
    const { address, placeId } = req.body;
    console.log(`[location] POST /geocode — address="${address}" placeId="${placeId}"`);

    if (!address && !placeId) {
      return res.status(400).json({ success: false, message: 'address or placeId is required' });
    }

    let url;
    if (placeId) {
      url = `https://maps.googleapis.com/maps/api/geocode/json?place_id=${encodeURIComponent(placeId)}&key=${GOOGLE_MAPS_API_KEY}`;
    } else {
      url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_MAPS_API_KEY}`;
    }

    const response = await googleMapsFetch(url);

    if (response.status !== 'OK') {
      console.warn(`[location] /geocode — non-OK status: ${response.status} (error_message: ${response.error_message || 'none'})`);
      return res.json({ success: true, data: null });
    }

    const r = response.results?.[0];
    if (!r) {
      return res.json({ success: true, data: null });
    }

    res.json({
      success: true,
      data: {
        placeId: r.place_id || '',
        title: r.formatted_address || '',
        lat: r.geometry?.location?.lat || 0,
        lng: r.geometry?.location?.lng || 0,
        address: r.formatted_address || '',
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

    // Google Roads API accepts max 100 points per request
    const path = points.map((p) => `${p.lat},${p.lng}`).join('|');
    const url = `https://roads.googleapis.com/v1/snapToRoads?path=${encodeURIComponent(path)}&interpolate=true&key=${GOOGLE_MAPS_API_KEY}`;
    const response = await googleMapsFetch(url);

    const snappedPoints = (response.snappedPoints || []).map((p) => ({
      lat: p.location.latitude,
      lng: p.location.longitude,
    }));

    res.json({ success: true, data: { snappedPoints } });
  } catch (err) {
    next(err);
  }
});

// POST /api/location/isoline
// Body: { lat, lng, minutes }
// Note: Google Maps doesn't have a direct isoline API.
// This uses a circle approximation based on average driving speed.
router.post('/isoline', authenticate, async (req, res, next) => {
  try {
    console.log(`[location] POST /isoline — lat=${req.body.lat} lng=${req.body.lng} minutes=${req.body.minutes}`);
    const { lat, lng, minutes } = req.body;
    if (lat == null || lng == null || !minutes) {
      return res.status(400).json({ success: false, message: 'lat, lng, and minutes are required' });
    }

    // Approximate isoline as a circle based on average city driving speed (~30 km/h)
    const avgSpeedKmH = 30;
    const radiusKm = (avgSpeedKmH * parseInt(minutes, 10)) / 60;
    const radiusMeters = radiusKm * 1000;
    const latF = parseFloat(lat);
    const lngF = parseFloat(lng);

    // Generate polygon points in a circle
    const numPoints = 36;
    const polygon = [];
    for (let i = 0; i <= numPoints; i++) {
      const angle = (i * 360) / numPoints;
      const rad = (angle * Math.PI) / 180;
      const dLat = (radiusMeters / 111320) * Math.cos(rad);
      const dLng = (radiusMeters / (111320 * Math.cos((latF * Math.PI) / 180))) * Math.sin(rad);
      polygon.push({ lat: latF + dLat, lng: lngF + dLng });
    }

    res.json({
      success: true,
      data: {
        geometry: polygon,
        distanceMeters: radiusMeters,
        durationSeconds: parseInt(minutes, 10) * 60,
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
    `https://maps.googleapis.com/maps/api/staticmap` +
    `?center=${lat},${lng}&zoom=${zoom}&size=${width}x${height}&key=${GOOGLE_MAPS_API_KEY}`;

  res.json({
    success: true,
    data: { url: staticMapUrl },
  });
});

// ──────────────────────────────────────────────────────────────
// BACKEND-ONLY ENDPOINTS
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

    const response = await googleMapsFetch(
      'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix',
      'POST',
      {
        origins: origins.map((o) => ({
          waypoint: { location: { latLng: { latitude: o.lat, longitude: o.lng } } },
        })),
        destinations: destinations.map((d) => ({
          waypoint: { location: { latLng: { latitude: d.lat, longitude: d.lng } } },
        })),
        travelMode: 'DRIVE',
      },
      {
        'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask': 'originIndex,destinationIndex,distanceMeters,duration',
      }
    );

    // Google returns an array of route matrix elements
    const matrix = (Array.isArray(response) ? response : [response]).map((entry) => ({
      originIndex: entry.originIndex || 0,
      destinationIndex: entry.destinationIndex || 0,
      distanceMeters: entry.distanceMeters || 0,
      duration: entry.duration || '0s',
    }));

    res.json({ success: true, data: matrix });
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

    // Use Google Directions API with waypoint optimization
    const waypointStr = 'optimize:true|' + waypoints.map((w) => `${w.lat},${w.lng}`).join('|');
    const url =
      `https://maps.googleapis.com/maps/api/directions/json` +
      `?origin=${origin.lat},${origin.lng}` +
      `&destination=${destination.lat},${destination.lng}` +
      `&waypoints=${encodeURIComponent(waypointStr)}` +
      `&key=${GOOGLE_MAPS_API_KEY}`;

    const response = await googleMapsFetch(url);

    const route = response.routes?.[0] || {};
    const waypointOrder = route.waypoint_order || [];
    const legs = route.legs || [];

    let totalDistance = 0;
    let totalDuration = 0;
    for (const leg of legs) {
      totalDistance += leg.distance?.value || 0;
      totalDuration += leg.duration?.value || 0;
    }

    const optimizedWaypoints = waypointOrder.map((originalIndex, newIndex) => ({
      position: { lat: waypoints[originalIndex].lat, lng: waypoints[originalIndex].lng },
      originalIndex,
    }));

    res.json({
      success: true,
      data: {
        optimizedWaypoints,
        distance: totalDistance,
        duration: totalDuration,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
