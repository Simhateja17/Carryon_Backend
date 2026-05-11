const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { haversineKm } = require('../lib/distance');
const { calculateRoute, optimizeWaypoints } = require('./locationProvider');
const { recordAudit } = require('./auditLog');

const ACTIVE_BOOKING_STATUSES = [
  'SEARCHING_DRIVER',
  'DRIVER_ASSIGNED',
  'DRIVER_ARRIVED',
  'PICKUP_DONE',
  'IN_TRANSIT',
  'ARRIVED_AT_DROP',
];
const ROUTE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const OVERVIEW_PRECISION = 3;
const MAX_OPTIMIZE_WAYPOINTS = 20;
const DRIVER_ROUTE_MOVEMENT_BUCKET_DEGREES = 0.0025;

function isValidLatitude(value) {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}

function isValidLongitude(value) {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}

function coordinate(lat, lng, precision = null) {
  const parsedLat = Number(lat);
  const parsedLng = Number(lng);
  if (!isValidLatitude(parsedLat) || !isValidLongitude(parsedLng)) return null;
  if (parsedLat === 0 && parsedLng === 0) return null;
  if (precision == null) return { lat: parsedLat, lng: parsedLng };
  const factor = 10 ** precision;
  return {
    lat: Math.round(parsedLat * factor) / factor,
    lng: Math.round(parsedLng * factor) / factor,
  };
}

function bucketCoordinateForRoute(point) {
  if (!point) return null;
  return {
    lat: Math.round(point.lat / DRIVER_ROUTE_MOVEMENT_BUCKET_DEGREES) * DRIVER_ROUTE_MOVEMENT_BUCKET_DEGREES,
    lng: Math.round(point.lng / DRIVER_ROUTE_MOVEMENT_BUCKET_DEGREES) * DRIVER_ROUTE_MOVEMENT_BUCKET_DEGREES,
  };
}

function routeHashFor(booking, routePhase = 'TO_DROPOFF', origin = null, destination = null) {
  const hashOrigin = routePhase === 'TO_PICKUP' ? bucketCoordinateForRoute(origin) : origin;
  const hashDestination = destination;
  const payload = [
    routePhase,
    hashOrigin?.lat,
    hashOrigin?.lng,
    hashDestination?.lat,
    hashDestination?.lng,
    booking.pickupAddress?.latitude,
    booking.pickupAddress?.longitude,
    booking.deliveryAddress?.latitude,
    booking.deliveryAddress?.longitude,
  ].join(':');
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

function metersBetween(a, b) {
  if (!a || !b) return null;
  return Math.round(haversineKm(a.lat, a.lng, b.lat, b.lng) * 1000);
}

function secondsFromDuration(duration) {
  if (typeof duration === 'number') return duration;
  if (typeof duration !== 'string') return 0;
  return Number.parseInt(duration.replace('s', ''), 10) || 0;
}

function bookingSelect() {
  return {
    id: true,
    orderCode: true,
    vehicleType: true,
    status: true,
    driverId: true,
    eta: true,
    distance: true,
    duration: true,
    updatedAt: true,
    createdAt: true,
    pickupAddress: true,
    deliveryAddress: true,
    user: { select: { id: true, name: true, email: true, phone: true } },
    driver: {
      select: {
        id: true,
        name: true,
        photo: true,
        isOnline: true,
        currentLatitude: true,
        currentLongitude: true,
        vehicle: { select: { type: true, licensePlate: true, make: true, model: true, year: true } },
      },
    },
    lifecycleEvents: {
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        command: true,
        success: true,
        message: true,
        latitude: true,
        longitude: true,
        distanceToExpectedMeters: true,
        createdAt: true,
      },
    },
  };
}

function mapBookingSummary(booking, precision = OVERVIEW_PRECISION) {
  const driverPosition = coordinate(
    booking.driver?.currentLatitude,
    booking.driver?.currentLongitude,
    precision
  );
  const pickup = coordinate(booking.pickupAddress?.latitude, booking.pickupAddress?.longitude, precision);
  const dropoff = coordinate(booking.deliveryAddress?.latitude, booking.deliveryAddress?.longitude, precision);

  return {
    bookingId: booking.id,
    orderCode: booking.orderCode,
    status: booking.status,
    vehicleType: booking.vehicleType,
    driver: booking.driver ? {
      id: booking.driver.id,
      name: booking.driver.name,
      photo: booking.driver.photo,
      isOnline: booking.driver.isOnline,
      vehicle: booking.driver.vehicle,
      position: driverPosition,
    } : null,
    route: {
      pickup,
      dropoff,
      pickupLabel: booking.pickupAddress?.label || booking.pickupAddress?.address || 'Pickup',
      dropoffLabel: booking.deliveryAddress?.label || booking.deliveryAddress?.address || 'Drop-off',
    },
    etaMinutes: booking.eta,
    updatedAt: booking.updatedAt.toISOString(),
  };
}

function minutesAgo(date) {
  if (!date) return null;
  const minutes = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function vehicleLabel(vehicle, fallbackType = '') {
  if (!vehicle) return fallbackType || 'Unassigned vehicle';
  const model = [vehicle.make, vehicle.model].filter(Boolean).join(' ').trim();
  const year = vehicle.year ? ` (${vehicle.year})` : '';
  const plate = vehicle.licensePlate ? ` - ${vehicle.licensePlate}` : '';
  return `${model || vehicle.type || fallbackType || 'Vehicle'}${year}${plate}`;
}

function routeProgressPercent(status) {
  const progressByStatus = {
    SEARCHING_DRIVER: 8,
    DRIVER_ASSIGNED: 18,
    DRIVER_ARRIVED: 32,
    PICKUP_DONE: 52,
    IN_TRANSIT: 72,
    ARRIVED_AT_DROP: 92,
    DELIVERED: 100,
  };
  return progressByStatus[status] || 0;
}

function nextStopFor(booking) {
  if (['SEARCHING_DRIVER', 'DRIVER_ASSIGNED', 'DRIVER_ARRIVED'].includes(booking.status)) {
    return booking.pickupAddress?.label || booking.pickupAddress?.address || 'Pickup';
  }
  return booking.deliveryAddress?.label || booking.deliveryAddress?.address || 'Drop-off';
}

function alertFromBooking(booking) {
  const failedEvent = booking.lifecycleEvents.find((event) => !event.success);
  if (failedEvent) {
    return {
      id: failedEvent.id,
      type: 'CONTROL EVENT',
      severity: 'critical',
      title: `${booking.orderCode || booking.id} ${String(failedEvent.command).replace(/_/g, ' ').toLowerCase()} failed`,
      detail: failedEvent.message || `${booking.driver?.name || 'Driver'} needs dispatch review`,
      occurredAt: failedEvent.createdAt.toISOString(),
      timeLabel: minutesAgo(failedEvent.createdAt),
      bookingId: booking.id,
      driverId: booking.driverId,
    };
  }

  const deviationEvent = [...booking.lifecycleEvents]
    .reverse()
    .find((event) => Number(event.distanceToExpectedMeters || 0) > 1000);
  if (deviationEvent) {
    const distanceKm = ((deviationEvent.distanceToExpectedMeters || 0) / 1000).toFixed(1);
    return {
      id: deviationEvent.id,
      type: 'ROUTE DEVIATION',
      severity: Number(deviationEvent.distanceToExpectedMeters || 0) > 5000 ? 'critical' : 'warning',
      title: `${booking.orderCode || booking.id} left planned route by ${distanceKm} km`,
      detail: `Driver: ${booking.driver?.name || 'Unassigned'} - ${nextStopFor(booking)}`,
      occurredAt: deviationEvent.createdAt.toISOString(),
      timeLabel: minutesAgo(deviationEvent.createdAt),
      bookingId: booking.id,
      driverId: booking.driverId,
    };
  }

  const staleMinutes = Math.round((Date.now() - new Date(booking.updatedAt).getTime()) / 60000);
  if (staleMinutes > 60) {
    return {
      id: `${booking.id}:delay`,
      type: 'ROUTE DELAY',
      severity: 'warning',
      title: `${booking.orderCode || booking.id} has not updated in ${staleMinutes}m`,
      detail: `Driver: ${booking.driver?.name || 'Unassigned'} - ${nextStopFor(booking)}`,
      occurredAt: booking.updatedAt.toISOString(),
      timeLabel: minutesAgo(booking.updatedAt),
      bookingId: booking.id,
      driverId: booking.driverId,
    };
  }

  return null;
}

function featuredDispatchFor(bookings) {
  const booking = bookings.find((entry) => entry.driver) || bookings[0];
  if (!booking || !booking.driver) return null;

  return {
    bookingId: booking.id,
    orderCode: booking.orderCode,
    driver: {
      id: booking.driver.id,
      name: booking.driver.name,
      photo: booking.driver.photo,
      isOnline: booking.driver.isOnline,
    },
    status: booking.status,
    dutyLabel: booking.driver.isOnline ? 'ON DUTY' : 'OFF DUTY',
    routeProgressPercent: routeProgressPercent(booking.status),
    vehicle: {
      label: vehicleLabel(booking.driver.vehicle, booking.vehicleType),
      type: booking.driver.vehicle?.type || booking.vehicleType,
      licensePlate: booking.driver.vehicle?.licensePlate || null,
    },
    nextStop: nextStopFor(booking),
    updatedAt: booking.updatedAt.toISOString(),
  };
}

function routePhaseForStatus(status) {
  if (['DRIVER_ASSIGNED', 'DRIVER_ARRIVED'].includes(status)) return 'TO_PICKUP';
  if (['PICKUP_DONE', 'IN_TRANSIT', 'ARRIVED_AT_DROP'].includes(status)) return 'TO_DROPOFF';
  return 'UNAVAILABLE';
}

function activeRouteWindowFor(booking, routePhase = routePhaseForStatus(booking.status)) {
  const pickup = coordinate(booking.pickupAddress?.latitude, booking.pickupAddress?.longitude);
  const dropoff = coordinate(booking.deliveryAddress?.latitude, booking.deliveryAddress?.longitude);
  const driverPosition = coordinate(booking.driver?.currentLatitude, booking.driver?.currentLongitude);

  if (routePhase === 'TO_PICKUP') {
    return {
      phase: routePhase,
      origin: driverPosition,
      originLabel: booking.driver?.name ? `${booking.driver.name} current location` : 'Driver current location',
      destination: pickup,
      destinationLabel: booking.pickupAddress?.label || booking.pickupAddress?.address || 'Pickup',
    };
  }

  if (routePhase === 'TO_DROPOFF') {
    return {
      phase: routePhase,
      origin: pickup,
      originLabel: booking.pickupAddress?.label || booking.pickupAddress?.address || 'Pickup',
      destination: dropoff,
      destinationLabel: booking.deliveryAddress?.label || booking.deliveryAddress?.address || 'Drop-off',
    };
  }

  return {
    phase: 'UNAVAILABLE',
    origin: null,
    originLabel: '',
    destination: null,
    destinationLabel: '',
  };
}

async function getPlannedRoute(booking, now = new Date(), routePhase = routePhaseForStatus(booking.status)) {
  const activeRouteWindow = activeRouteWindowFor(booking, routePhase);
  const { origin, destination } = activeRouteWindow;
  if (!origin || !destination) {
    return {
      geometry: [],
      distanceMeters: 0,
      durationSeconds: 0,
      source: 'missing_coordinates',
      routePhase: activeRouteWindow.phase,
      activeRouteWindow,
    };
  }

  const routeHash = routeHashFor(booking, activeRouteWindow.phase, origin, destination);
  const cached = await prisma.plannedRouteSnapshot.findFirst({
    where: { bookingId: booking.id, routeHash, expiresAt: { gt: now } },
    orderBy: { updatedAt: 'desc' },
  });
  if (cached) {
    return {
      geometry: cached.geometry || [],
      distanceMeters: cached.distanceMeters,
      durationSeconds: cached.durationSeconds,
      source: 'cache',
      expiresAt: cached.expiresAt.toISOString(),
      routePhase: activeRouteWindow.phase,
      activeRouteWindow,
    };
  }

  let route;
  try {
    const calculated = await calculateRoute(origin.lat, origin.lng, destination.lat, destination.lng);
    route = {
      geometry: calculated.geometry || [origin, destination],
      distanceMeters: Math.round((calculated.distance || 0) * 1000),
      durationSeconds: Math.round((calculated.duration || 0) * 60),
      source: calculated.isEstimated ? 'google_estimated' : 'google',
    };
  } catch (err) {
    route = {
      geometry: [origin, destination],
      distanceMeters: metersBetween(origin, destination) || 0,
      durationSeconds: Math.max(0, (booking.duration || 0) * 60),
      source: 'fallback',
    };
  }

  await prisma.plannedRouteSnapshot.upsert({
    where: { bookingId_routeHash: { bookingId: booking.id, routeHash } },
    create: {
      bookingId: booking.id,
      routeHash,
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      geometry: route.geometry,
      expiresAt: new Date(now.getTime() + ROUTE_CACHE_TTL_MS),
    },
    update: {
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      geometry: route.geometry,
      expiresAt: new Date(now.getTime() + ROUTE_CACHE_TTL_MS),
    },
  });

  return {
    ...route,
    routePhase: activeRouteWindow.phase,
    activeRouteWindow,
  };
}

function actualPathFor(booking) {
  const events = booking.lifecycleEvents
    .map((event) => ({
      position: coordinate(event.latitude, event.longitude),
      command: event.command,
      success: event.success,
      capturedAt: event.createdAt.toISOString(),
      distanceToExpectedMeters: event.distanceToExpectedMeters,
    }))
    .filter((event) => event.position);

  const latestGps = coordinate(booking.driver?.currentLatitude, booking.driver?.currentLongitude);
  if (latestGps) {
    events.push({
      position: latestGps,
      command: 'DRIVER_GPS',
      success: true,
      capturedAt: new Date().toISOString(),
      distanceToExpectedMeters: null,
    });
  }

  return events;
}

function nearestRouteDistanceMeters(point, routeGeometry) {
  if (!point || !Array.isArray(routeGeometry) || routeGeometry.length === 0) return null;
  let nearest = Infinity;
  for (const candidate of routeGeometry) {
    const candidatePoint = coordinate(candidate.lat, candidate.lng);
    if (!candidatePoint) continue;
    nearest = Math.min(nearest, metersBetween(point, candidatePoint));
  }
  return Number.isFinite(nearest) ? Math.round(nearest) : null;
}

function deviationFor(booking, plannedRoute, actualPath) {
  const latest = actualPath[actualPath.length - 1]?.position || null;
  const distanceFromPlannedMeters = nearestRouteDistanceMeters(latest, plannedRoute.geometry);
  const staleMinutes = Math.round((Date.now() - new Date(booking.updatedAt).getTime()) / 60000);
  return {
    distanceFromPlannedMeters,
    status: distanceFromPlannedMeters == null
      ? 'UNKNOWN'
      : distanceFromPlannedMeters > 5000
        ? 'OFF_ROUTE'
        : distanceFromPlannedMeters > 1000
          ? 'WATCH'
          : 'ON_ROUTE',
    stale: staleMinutes > 30,
  };
}

async function getLiveOverviewSnapshot() {
  const [bookings, onlineDrivers] = await Promise.all([
    prisma.booking.findMany({
      where: { status: { in: ACTIVE_BOOKING_STATUSES } },
      orderBy: { updatedAt: 'desc' },
      take: 80,
      select: bookingSelect(),
    }),
    prisma.driver.findMany({
      where: { isOnline: true },
      orderBy: { createdAt: 'desc' },
      take: 80,
      select: { id: true, name: true, isOnline: true, currentLatitude: true, currentLongitude: true, vehicle: { select: { type: true, licensePlate: true } } },
    }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    precision: 'overview_bucketed',
    stats: {
      active: bookings.length,
      onlineDrivers: onlineDrivers.length,
      delayed: bookings.filter((booking) => booking.updatedAt < new Date(Date.now() - 60 * 60 * 1000)).length,
      idle: Math.max(onlineDrivers.length - bookings.filter((booking) => booking.driverId).length, 0),
      enRoute: bookings.filter((booking) => ['PICKUP_DONE', 'IN_TRANSIT', 'ARRIVED_AT_DROP'].includes(booking.status)).length,
    },
    bookings: bookings.map((booking) => mapBookingSummary(booking)),
    drivers: onlineDrivers.map((driver) => ({
      id: driver.id,
      name: driver.name,
      isOnline: driver.isOnline,
      vehicle: driver.vehicle,
      position: coordinate(driver.currentLatitude, driver.currentLongitude, OVERVIEW_PRECISION),
    })).filter((driver) => driver.position),
  };
}

async function getLiveDashboardSnapshot() {
  const [bookings, onlineDrivers] = await Promise.all([
    prisma.booking.findMany({
      where: { status: { in: ACTIVE_BOOKING_STATUSES } },
      orderBy: { updatedAt: 'desc' },
      take: 80,
      select: bookingSelect(),
    }),
    prisma.driver.findMany({
      where: { isOnline: true },
      orderBy: { createdAt: 'desc' },
      take: 80,
      select: {
        id: true,
        name: true,
        isOnline: true,
        currentLatitude: true,
        currentLongitude: true,
        vehicle: { select: { type: true, licensePlate: true } },
      },
    }),
  ]);

  const assignedDriverIds = new Set(bookings.map((booking) => booking.driverId).filter(Boolean));

  return {
    generatedAt: new Date().toISOString(),
    source: 'database',
    precision: 'overview_bucketed',
    stale: false,
    stats: {
      active: bookings.length,
      onlineDrivers: onlineDrivers.length,
      delayed: bookings.filter((booking) => booking.updatedAt < new Date(Date.now() - 60 * 60 * 1000)).length,
      idle: Math.max(onlineDrivers.filter((driver) => !assignedDriverIds.has(driver.id)).length, 0),
      enRoute: bookings.filter((booking) => ['PICKUP_DONE', 'IN_TRANSIT', 'ARRIVED_AT_DROP'].includes(booking.status)).length,
    },
    bookings: bookings.map((booking) => mapBookingSummary(booking)),
    drivers: onlineDrivers.map((driver) => ({
      id: driver.id,
      name: driver.name,
      isOnline: driver.isOnline,
      vehicle: driver.vehicle,
      position: coordinate(driver.currentLatitude, driver.currentLongitude, OVERVIEW_PRECISION),
    })).filter((driver) => driver.position),
    activeAlerts: bookings
      .map(alertFromBooking)
      .filter(Boolean)
      .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
      .slice(0, 5),
    featuredDispatch: featuredDispatchFor(bookings),
  };
}

async function getIncidentMapSnapshot() {
  const bookings = await prisma.booking.findMany({
    where: { status: { in: ACTIVE_BOOKING_STATUSES } },
    orderBy: { updatedAt: 'asc' },
    take: 30,
    select: bookingSelect(),
  });

  const incidents = [];
  for (const booking of bookings) {
    const routePhase = routePhaseForStatus(booking.status);
    const plannedRoute = await getPlannedRoute(booking, new Date(), routePhase);
    const actualPath = actualPathFor(booking);
    const deviation = deviationFor(booking, plannedRoute, actualPath);
    if (deviation.status === 'OFF_ROUTE' || deviation.stale || booking.lifecycleEvents.some((event) => !event.success)) {
      incidents.push({
        id: booking.id,
        type: deviation.status === 'OFF_ROUTE' ? 'DEVIATION' : deviation.stale ? 'DELAY' : 'CONTROL_EVENT',
        severity: deviation.status === 'OFF_ROUTE' ? 'critical' : 'warning',
        booking: mapBookingSummary(booking, null),
        plannedRoute,
        actualPath,
        deviation,
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    precision: 'detail_exact',
    incidents,
  };
}

async function resolveDispatchBooking(bookingId) {
  if (bookingId === 'latest') {
    return prisma.booking.findFirst({
      where: { status: { in: ACTIVE_BOOKING_STATUSES } },
      orderBy: { updatedAt: 'desc' },
      select: bookingSelect(),
    });
  }

  return prisma.booking.findFirst({
    where: {
      OR: [{ id: bookingId }, { orderCode: bookingId }],
    },
    select: bookingSelect(),
  });
}

async function getDispatchMapSnapshot(bookingId) {
  const booking = await resolveDispatchBooking(bookingId);
  if (!booking) return null;
  const routePhase = routePhaseForStatus(booking.status);
  const plannedRoute = await getPlannedRoute(booking, new Date(), routePhase);
  const actualPath = actualPathFor(booking);
  return {
    generatedAt: new Date().toISOString(),
    precision: 'detail_exact',
    booking: mapBookingSummary(booking, null),
    routePhase,
    activeRouteWindow: plannedRoute.activeRouteWindow,
    plannedRoute,
    actualPath,
    deviation: deviationFor(booking, plannedRoute, actualPath),
    events: booking.lifecycleEvents.map((event) => ({
      id: event.id,
      command: event.command,
      success: event.success,
      message: event.message,
      position: coordinate(event.latitude, event.longitude),
      distanceToExpectedMeters: event.distanceToExpectedMeters,
      createdAt: event.createdAt.toISOString(),
    })),
  };
}

async function getOptimizeQueueSnapshot() {
  const bookings = await prisma.booking.findMany({
    where: { status: { in: ACTIVE_BOOKING_STATUSES }, driverId: { not: null } },
    orderBy: [{ eta: 'desc' }, { updatedAt: 'asc' }],
    take: MAX_OPTIMIZE_WAYPOINTS,
    select: bookingSelect(),
  });

  return {
    generatedAt: new Date().toISOString(),
    waypointCap: MAX_OPTIMIZE_WAYPOINTS,
    selectedCount: bookings.length,
    queue: bookings.map((booking, index) => ({
      priority: index + 1,
      booking: mapBookingSummary(booking),
      status: index < 3 ? 'CALCULATING' : 'PENDING',
      savingsPct: 0,
    })),
  };
}

async function runOptimize({ actor, actorId } = {}) {
  const auditActor = actor || (actorId ? { actorId, actorType: 'ADMIN' } : null);
  if (!auditActor?.actorId) {
    const err = new Error('Admin actor identity is required');
    err.statusCode = 401;
    throw err;
  }

  const queue = await getOptimizeQueueSnapshot();
  const candidates = queue.queue
    .map((entry) => entry.booking.route.dropoff)
    .filter(Boolean)
    .slice(0, MAX_OPTIMIZE_WAYPOINTS);

  if (candidates.length < 2) {
    return { generatedAt: new Date().toISOString(), status: 'SKIPPED', reason: 'Not enough route points', queue };
  }

  const origin = candidates[0];
  const destination = candidates[candidates.length - 1];
  const waypoints = candidates.slice(1, -1);
  let optimization;
  try {
    optimization = await optimizeWaypoints(origin, destination, waypoints);
  } catch (err) {
    optimization = {
      optimizedWaypoints: waypoints.map((point, originalIndex) => ({ position: point, originalIndex })),
      distance: 0,
      duration: 0,
      fallbackReason: 'google_optimization_unavailable',
    };
  }

  await recordAudit(prisma, {
    actor: auditActor,
    action: 'MAP_OPTIMIZATION_RUN',
    entityType: 'AdminMaps',
    entityId: 'optimize/run',
    newValue: { selectedCount: queue.selectedCount, waypointCount: candidates.length },
  });

  return {
    generatedAt: new Date().toISOString(),
    status: optimization.fallbackReason ? 'FALLBACK' : 'COMPLETED',
    queue,
    optimizedRoute: {
      origin,
      destination,
      waypoints: optimization.optimizedWaypoints || [],
      distanceMeters: optimization.distance || 0,
      durationSeconds: secondsFromDuration(optimization.duration),
    },
  };
}

function assertBookingIdShape(bookingId) {
  if (typeof bookingId !== 'string') return false;
  if (bookingId === 'latest') return true;
  return /^[A-Za-z0-9][A-Za-z0-9_-]{2,80}$/.test(bookingId);
}

module.exports = {
  ACTIVE_BOOKING_STATUSES,
  MAX_OPTIMIZE_WAYPOINTS,
  OVERVIEW_PRECISION,
  assertBookingIdShape,
  activeRouteWindowFor,
  coordinate,
  deviationFor,
  getDispatchMapSnapshot,
  getIncidentMapSnapshot,
  getLiveDashboardSnapshot,
  getLiveOverviewSnapshot,
  getOptimizeQueueSnapshot,
  getPlannedRoute,
  routeHashFor,
  routePhaseForStatus,
  routeProgressPercent,
  runOptimize,
  vehicleLabel,
};
