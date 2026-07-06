// ── Dispatch Module ─────────────────────────────────────────
// Answers: which Drivers should see this Booking, in what
// order, and through which notification path?

const prisma = require('../lib/prisma');
const { haversineKm } = require('../lib/distance');
const { taxExclusiveSplitFromGross } = require('../lib/money');
const { sendPushToDriverIds } = require('../lib/pushNotifications');
const { DRIVER_SEARCH_RADIUS_KM, OFFER_EXPIRY_MS } = require('./businessConfig');
const { evaluateDriverEligibility } = require('./driverEligibility');

// Job-request pushes ring on the app's dedicated custom-sound channel.
// Android: raw resource name (no extension). iOS/APNs: bundled file name.
const JOB_REQUEST_PUSH_OPTIONS = {
  androidChannelId: 'carryon_job_requests',
  androidSound: 'alert_sonar',
  apnsSound: 'alert_sonar.caf',
};

const DRIVER_DISPATCH_SELECT = {
  id: true,
  name: true,
  email: true,
  isOnline: true,
  isVerified: true,
  verificationStatus: true,
  stripeConnectAccountId: true,
  stripeDetailsSubmitted: true,
  stripePayoutsEnabled: true,
  stripeRequirements: true,
  currentLatitude: true,
  currentLongitude: true,
  documents: { select: { type: true, status: true, expiryDate: true } },
  vehicle: { select: { type: true } },
  bankName: true,
  bankAccountHolder: true,
  bankAccountNumber: true,
  bankDetailsStatus: true,
};

// ── Incoming job queries for driver app ─────────────────────

function activeOfferWhereClause(extraWhere = {}) {
  return {
    status: 'SEARCHING_DRIVER',
    paymentStatus: 'COMPLETED',
    driverId: null,
    createdAt: { gte: new Date(Date.now() - OFFER_EXPIRY_MS) },
    ...extraWhere,
  };
}

function bookingPayout(booking) {
  return taxExclusiveSplitFromGross(booking.finalPrice || booking.estimatedPrice || 0).driverAmount;
}

function sortByPayout(bookings) {
  return [...bookings].sort((a, b) => {
    const payoutDiff = bookingPayout(b) - bookingPayout(a);
    if (payoutDiff !== 0) return payoutDiff;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

function filterNearbyWithVehicleMatch(bookings, driverLat, driverLng, driverVehicleType) {
  return bookings.filter((booking) => {
    const withinRadius =
      haversineKm(
        driverLat,
        driverLng,
        booking.pickupAddress.latitude,
        booking.pickupAddress.longitude
      ) <= DRIVER_SEARCH_RADIUS_KM;
    const vehicleMatches = !driverVehicleType || booking.vehicleType === driverVehicleType;
    return withinRadius && vehicleMatches;
  });
}

function driverDispatchDecision(booking, driver) {
  const pickupLat = Number(booking.pickupAddress?.latitude);
  const pickupLng = Number(booking.pickupAddress?.longitude);
  const driverLat = Number(driver.currentLatitude);
  const driverLng = Number(driver.currentLongitude);
  const distanceKm =
    Number.isFinite(pickupLat) &&
    Number.isFinite(pickupLng) &&
    Number.isFinite(driverLat) &&
    Number.isFinite(driverLng)
      ? haversineKm(pickupLat, pickupLng, driverLat, driverLng)
      : null;
  const eligibility = evaluateDriverEligibility(driver);
  const vehicleMatches = !booking.vehicleType || !driver.vehicle?.type || driver.vehicle.type === booking.vehicleType;
  const withinRadius = distanceKm != null && distanceKm <= DRIVER_SEARCH_RADIUS_KM;
  const reasons = [];
  if (driver.isOnline === false) reasons.push('offline');
  if (!eligibility.canGoOnline) {
    reasons.push(`eligibility:${eligibility.primaryBlocker?.code || eligibility.status || 'blocked'}`);
  }
  if (distanceKm == null) reasons.push('missing-location');
  if (distanceKm != null && !withinRadius) reasons.push(`outside-radius:${distanceKm.toFixed(2)}km`);
  if (!vehicleMatches) reasons.push(`vehicle-mismatch:${driver.vehicle?.type || 'none'}!=${booking.vehicleType}`);

  return {
    driverId: driver.id,
    driverName: driver.name || driver.email || driver.id,
    distanceKm: distanceKm == null ? null : Number(distanceKm.toFixed(3)),
    vehicleType: driver.vehicle?.type || null,
    eligible: reasons.length === 0,
    reasons,
  };
}

function selectEligibleDriversForBooking(booking, drivers) {
  return drivers.filter((driver) => driverDispatchDecision(booking, driver).eligible);
}

async function getIncomingBookingsForDriver(driver, bookingInclude) {
  console.log(
    '[dispatch] incoming_check_started',
    'driverId:', driver.id,
    'driverName:', driver.name || driver.email || '',
    'location:', driver.currentLatitude, driver.currentLongitude,
    'vehicleType:', driver.vehicle?.type || 'none'
  );

  // Fetch bookings this driver has already rejected
  const rejections = await prisma.bookingRejection.findMany({
    where: { driverId: driver.id },
    select: { bookingId: true },
  });
  const rejectedIds = rejections.map(r => r.bookingId);
  console.log(
    '[dispatch] incoming_rejections_loaded',
    'driverId:', driver.id,
    'rejectedCount:', rejectedIds.length,
    'rejectedBookingIds:', rejectedIds
  );

  // First priority: explicit admin-targeted requests for this driver
  const targetedNotifications = await prisma.driverNotification.findMany({
    where: { driverId: driver.id, type: 'JOB_REQUEST' },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { actionData: true },
  });

  const targetedBookingIds = targetedNotifications
    .map((n) => {
      try {
        const payload = n.actionData ? JSON.parse(n.actionData) : null;
        if (!payload || payload.targeted !== true || !payload.bookingId) return null;
        return String(payload.bookingId);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  console.log(
    '[dispatch] incoming_targeted_notifications_loaded',
    'driverId:', driver.id,
    'notificationCount:', targetedNotifications.length,
    'targetedBookingIds:', targetedBookingIds
  );

  const targetedBookings = targetedBookingIds.length > 0
    ? await prisma.booking.findMany({
      where: activeOfferWhereClause({
        id: {
          in: targetedBookingIds,
          ...(rejectedIds.length > 0 && { notIn: rejectedIds }),
        },
      }),
      include: bookingInclude,
      take: 50,
    })
    : [];
  console.log(
    '[dispatch] incoming_targeted_bookings_loaded',
    'driverId:', driver.id,
    'bookingCount:', targetedBookings.length,
    'bookingIds:', targetedBookings.map((booking) => booking.id)
  );

  const bookings = await prisma.booking.findMany({
    where: activeOfferWhereClause(
      rejectedIds.length > 0 ? { id: { notIn: rejectedIds } } : {}
    ),
    include: bookingInclude,
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  console.log(
    '[dispatch] incoming_active_offers_loaded',
    'driverId:', driver.id,
    'activeOfferCount:', bookings.length,
    'activeOfferIds:', bookings.map((booking) => booking.id)
  );

  const nearby = filterNearbyWithVehicleMatch(
    bookings,
    driver.currentLatitude,
    driver.currentLongitude,
    driver.vehicle?.type
  );
  console.log(
    '[dispatch] incoming_nearby_filter_result',
    'driverId:', driver.id,
    'nearbyCount:', nearby.length,
    'nearbyBookingIds:', nearby.map((booking) => booking.id)
  );

  const dedupedById = new Map();
  [...targetedBookings, ...nearby].forEach((booking) => {
    if (!dedupedById.has(booking.id)) {
      dedupedById.set(booking.id, booking);
    }
  });

  const sorted = sortByPayout(Array.from(dedupedById.values()));
  console.log(
    '[dispatch] incoming_result',
    'driverId:', driver.id,
    'resultCount:', sorted.length,
    'resultBookingIds:', sorted.map((booking) => booking.id)
  );
  return sorted;
}

// ── Notify drivers after booking creation ───────────────────

async function notifyNearbyDrivers(booking) {
  if (booking.status !== 'SEARCHING_DRIVER' || booking.paymentStatus !== 'COMPLETED') {
    console.warn('[dispatch] refusing to notify drivers for unpaid/inactive booking:', booking.id, booking.status, booking.paymentStatus);
    return;
  }

  const drivers = await prisma.driver.findMany({
    where: { isOnline: true },
    select: DRIVER_DISPATCH_SELECT,
  });

  const bookingVehicleType = booking.vehicleType;

  console.log('[dispatch] driver search — booking:', booking.id, '| vehicleType:', bookingVehicleType, '| online drivers:', drivers.length);
  console.log(
    '[dispatch] driver_search_context',
    'bookingId:', booking.id,
    'orderCode:', booking.orderCode || '',
    'pickup:', `${booking.pickupAddress?.latitude},${booking.pickupAddress?.longitude}`,
    'pickupAddress:', booking.pickupAddress?.address || '',
    'deliveryAddress:', booking.deliveryAddress?.address || '',
    'radiusKm:', DRIVER_SEARCH_RADIUS_KM,
    'offerExpiryMs:', OFFER_EXPIRY_MS
  );

  const decisions = drivers.map((driver) => driverDispatchDecision(booking, driver));
  decisions.forEach((decision) => {
    console.log(
      '[dispatch] driver_candidate_decision',
      'bookingId:', booking.id,
      'driverId:', decision.driverId,
      'driverName:', decision.driverName,
      'distanceKm:', decision.distanceKm == null ? 'unknown' : decision.distanceKm,
      'vehicleType:', decision.vehicleType || 'none',
      'eligible:', decision.eligible,
      'reasons:', decision.reasons.length > 0 ? decision.reasons.join(',') : 'eligible'
    );
  });

  const nearbyDrivers = selectEligibleDriversForBooking(booking, drivers);

  console.log('[dispatch] nearby drivers (within', DRIVER_SEARCH_RADIUS_KM, 'km):', nearbyDrivers.length,
    '| notifying:', nearbyDrivers.map(d => d.name));

  const nearbyDriverIds = nearbyDrivers.map(d => d.id);
  if (nearbyDriverIds.length === 0) {
    console.log(
      '[dispatch] no nearby drivers found for booking:',
      booking.id,
      'candidateCount:', drivers.length,
      'blockedCandidates:', decisions.filter((decision) => !decision.eligible).length
    );
    return;
  }

  console.log(
    '[dispatch] push_job_request_start',
    'bookingId:', booking.id,
    'driverIds:', nearbyDriverIds
  );
  const result = await sendPushToDriverIds(
    nearbyDriverIds,
    { title: 'New Ride Request!', body: 'A new delivery job is available near you.' },
    { type: 'JOB_REQUEST', bookingId: booking.id },
    JOB_REQUEST_PUSH_OPTIONS
  );

  console.log(
    '[dispatch] FCM push sent for booking',
    booking.id,
    '— successCount:', result?.successCount,
    'failureCount:', result?.failureCount,
    'deliveredDriverIds:', result?.deliveredActorIds || [],
    'failedDriverIds:', result?.failedActorIds || [],
    'noDeviceDriverIds:', result?.noDeviceActorIds || [],
    'noDeviceDrivers:', result?.noDeviceActorIds?.length || 0
  );
}

// ── Admin dispatch: notify targeted or nearby drivers ───────

async function notifyDriversForAdminBooking(booking, driverIds) {
  const isDirectTargeted = driverIds.length > 0;
  const driverWhere = isDirectTargeted
    ? { id: { in: driverIds } }
    : { isOnline: true };

  const candidateDrivers = await prisma.driver.findMany({
    where: driverWhere,
    select: DRIVER_DISPATCH_SELECT,
  });

  const nearbyDrivers = isDirectTargeted
    ? candidateDrivers.filter((driver) => driver.isOnline !== false && evaluateDriverEligibility(driver).canGoOnline)
    : selectEligibleDriversForBooking(booking, candidateDrivers);

  const targetedDrivers = nearbyDrivers.map((d) => ({
    id: d.id,
    name: d.name,
    email: d.email,
  }));

  if (nearbyDrivers.length > 0) {
    await prisma.driverNotification.createMany({
      data: nearbyDrivers.map((driver) => ({
        driverId: driver.id,
        title: 'New Ride Request!',
        message: `${booking.pickupAddress.address} → ${booking.deliveryAddress.address} (${booking.estimatedPrice.toFixed(2)})`,
        type: 'JOB_REQUEST',
        actionData: JSON.stringify({
          bookingId: booking.id,
          source: 'admin',
          targeted: isDirectTargeted,
        }),
      })),
    });
  }

  let pushResult = {
    successCount: 0,
    failureCount: 0,
    failedTokens: [],
    invalidTokens: [],
    cleanedInvalidTokens: 0,
    deliveredActorIds: [],
    failedActorIds: [],
    noDeviceActorIds: [],
  };

  if (nearbyDrivers.length > 0) {
    pushResult = await sendPushToDriverIds(
      nearbyDrivers.map((driver) => driver.id),
      {
        title: 'New Ride Request!',
        body: `${booking.pickupAddress.address} → ${booking.deliveryAddress.address}`,
      },
      {
        type: 'JOB_REQUEST',
        bookingId: booking.id,
        source: 'admin',
        targeted: isDirectTargeted ? 'true' : 'false',
      },
      JOB_REQUEST_PUSH_OPTIONS
    );
  }

  return { targetedDrivers, nearbyDrivers, pushResult, isDirectTargeted };
}

module.exports = {
  DRIVER_DISPATCH_SELECT,
  getIncomingBookingsForDriver,
  notifyNearbyDrivers,
  notifyDriversForAdminBooking,
  filterNearbyWithVehicleMatch,
  selectEligibleDriversForBooking,
  sortByPayout,
  driverDispatchDecision,
  OFFER_EXPIRY_MS,
};
