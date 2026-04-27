// ── Location Provider Module ────────────────────────────────
// Google Maps adapter. Routes call domain-shaped operations
// instead of building Google requests inline.

const { haversineKm } = require('../lib/distance');

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

// ── Generic Google Maps fetch ───────────────────────────────

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
    console.error(`[Google Maps]  ${method} — ${response.status} (${elapsed}ms): ${errText}`);
    const err = new Error(`Google Maps API error (${response.status}): ${errText}`);
    err.statusCode = response.status;
    throw err;
  }

  console.log(`[Google Maps]  ${method} — ${response.status} (${elapsed}ms)`);

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response;
}

// ── Fallback distance when Google can't return a route ──────

function fallbackRouteDistance(originLat, originLng, destLat, destLng) {
  const directKm = haversineKm(originLat, originLng, destLat, destLng);
  if (!Number.isFinite(directKm) || directKm <= 0) {
    return { distance: 0, duration: 0 };
  }
  const estimatedRoadKm = Math.round(directKm * 1.25 * 100) / 100;
  return {
    distance: estimatedRoadKm,
    duration: Math.max(5, Math.round((estimatedRoadKm / 30) * 60)),
  };
}

// ── Domain operations ───────────────────────────────────────

async function searchPlaces(query, lat, lng) {
  const body = { textQuery: query, maxResultCount: 10 };
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

  return (response.places || []).map((p) => ({
    placeId: p.id || '',
    label: p.displayName?.text || '',
    address: p.formattedAddress || '',
    city: (p.addressComponents || []).find((c) => (c.types || []).includes('locality'))?.longText || '',
    region: (p.addressComponents || []).find((c) => (c.types || []).includes('administrative_area_level_1'))?.longText || '',
    country: (p.addressComponents || []).find((c) => (c.types || []).includes('country'))?.longText || '',
    latitude: p.location?.latitude || 0,
    longitude: p.location?.longitude || 0,
  }));
}

async function autocomplete(query, lat, lng) {
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

  return (response.suggestions || [])
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
}

async function reverseGeocode(lat, lng) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${GOOGLE_MAPS_API_KEY}`;
  const response = await googleMapsFetch(url);

  if (response.status !== 'OK') {
    console.warn(`[location] reverse-geocode — non-OK status: ${response.status} (error_message: ${response.error_message || 'none'})`);
    return null;
  }

  const r = response.results?.[0];
  if (!r) return null;

  const components = r.address_components || [];
  return {
    placeId: r.place_id || '',
    label: r.formatted_address || '',
    address: r.formatted_address || '',
    city: components.find((c) => c.types?.includes('locality'))?.long_name || '',
    region: components.find((c) => c.types?.includes('administrative_area_level_1'))?.long_name || '',
    country: components.find((c) => c.types?.includes('country'))?.long_name || '',
    latitude: r.geometry?.location?.lat || 0,
    longitude: r.geometry?.location?.lng || 0,
  };
}

async function geocode({ address, placeId }) {
  let url;
  if (placeId) {
    url = `https://maps.googleapis.com/maps/api/geocode/json?place_id=${encodeURIComponent(placeId)}&key=${GOOGLE_MAPS_API_KEY}`;
  } else {
    url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_MAPS_API_KEY}`;
  }

  const response = await googleMapsFetch(url);

  if (response.status !== 'OK') {
    console.warn(`[location] geocode — non-OK status: ${response.status}`);
    return null;
  }

  const r = response.results?.[0];
  if (!r) return null;

  return {
    placeId: r.place_id || '',
    title: r.formatted_address || '',
    lat: r.geometry?.location?.lat || 0,
    lng: r.geometry?.location?.lng || 0,
    address: r.formatted_address || '',
  };
}

function decodeEncodedPolyline(encoded) {
  const geometry = [];
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
  return geometry;
}

async function calculateRoute(originLat, originLng, destLat, destLng) {
  const response = await googleMapsFetch(
    'https://routes.googleapis.com/directions/v2:computeRoutes',
    'POST',
    {
      origin: { location: { latLng: { latitude: originLat, longitude: originLng } } },
      destination: { location: { latLng: { latitude: destLat, longitude: destLng } } },
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
  const fallback = fallbackRouteDistance(originLat, originLng, destLat, destLng);

  // Parse GeoJSON LineString geometry
  let geometry = [];
  const coords = route.polyline?.geoJsonLinestring?.coordinates || [];
  for (const coord of coords) {
    geometry.push({ lat: coord[1], lng: coord[0] });
  }

  // Fallback: decode encoded polyline if GeoJSON was empty
  if (geometry.length === 0 && route.polyline?.encodedPolyline) {
    geometry = decodeEncodedPolyline(route.polyline.encodedPolyline);
  }

  return {
    distance: distanceMeters > 0 ? Math.round(distanceMeters / 1000 * 100) / 100 : fallback.distance,
    duration: durationSeconds > 0 ? Math.round(durationSeconds / 60) : fallback.duration,
    geometry,
    isEstimated: distanceMeters <= 0,
  };
}

async function searchNearby(lat, lng, categories, radius) {
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

  return (response.places || []).map((p) => ({
    placeId: p.id || '',
    title: p.displayName?.text || '',
    address: p.formattedAddress || '',
    categories: p.types || [],
    distance: 0,
    lat: p.location?.latitude || 0,
    lng: p.location?.longitude || 0,
  }));
}

async function snapToRoads(points) {
  const path = points.map((p) => `${p.lat},${p.lng}`).join('|');
  const url = `https://roads.googleapis.com/v1/snapToRoads?path=${encodeURIComponent(path)}&interpolate=true&key=${GOOGLE_MAPS_API_KEY}`;
  const response = await googleMapsFetch(url);

  return (response.snappedPoints || []).map((p) => ({
    lat: p.location.latitude,
    lng: p.location.longitude,
  }));
}

async function routeMatrix(origins, destinations) {
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

  return (Array.isArray(response) ? response : [response]).map((entry) => ({
    originIndex: entry.originIndex || 0,
    destinationIndex: entry.destinationIndex || 0,
    distanceMeters: entry.distanceMeters || 0,
    duration: entry.duration || '0s',
  }));
}

async function optimizeWaypoints(origin, destination, waypoints) {
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

  const optimizedWaypoints = waypointOrder.map((originalIndex) => ({
    position: { lat: waypoints[originalIndex].lat, lng: waypoints[originalIndex].lng },
    originalIndex,
  }));

  return { optimizedWaypoints, distance: totalDistance, duration: totalDuration };
}

function buildStaticMapUrl(lat, lng, zoom = 13, width = 400, height = 300) {
  return `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=${zoom}&size=${width}x${height}&key=${GOOGLE_MAPS_API_KEY}`;
}

function buildIsolinePolygon(lat, lng, minutes) {
  const avgSpeedKmH = 30;
  const radiusKm = (avgSpeedKmH * parseInt(minutes, 10)) / 60;
  const radiusMeters = radiusKm * 1000;
  const latF = parseFloat(lat);
  const lngF = parseFloat(lng);

  const numPoints = 36;
  const polygon = [];
  for (let i = 0; i <= numPoints; i++) {
    const angle = (i * 360) / numPoints;
    const rad = (angle * Math.PI) / 180;
    const dLat = (radiusMeters / 111320) * Math.cos(rad);
    const dLng = (radiusMeters / (111320 * Math.cos((latF * Math.PI) / 180))) * Math.sin(rad);
    polygon.push({ lat: latF + dLat, lng: lngF + dLng });
  }

  return {
    geometry: polygon,
    distanceMeters: radiusMeters,
    durationSeconds: parseInt(minutes, 10) * 60,
  };
}

module.exports = {
  searchPlaces,
  autocomplete,
  reverseGeocode,
  geocode,
  calculateRoute,
  searchNearby,
  snapToRoads,
  routeMatrix,
  optimizeWaypoints,
  buildStaticMapUrl,
  buildIsolinePolygon,
  fallbackRouteDistance,
  GOOGLE_MAPS_API_KEY,
};
