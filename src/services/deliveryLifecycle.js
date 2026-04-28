const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { haversineKm } = require('../lib/distance');
const { driverEarningFromGross } = require('../lib/money');
const { notifyUserBookingEvent } = require('../lib/pushNotifications');
const { OFFER_EXPIRY_MS } = require('./businessConfig');
const { recordAudit } = require('./auditLog');
const {
  isSettlementEligible,
  creditDriverEarning,
} = require('./bookingLifecycle');
const {
  generateDeliveryOtp,
  deliveryOtpWindow,
  deliveryOtpPayload,
  maskEmail,
  sendEmailOtp,
  verifyDeliveryOtp,
  verifyUserDeliveryOtp,
} = require('./deliveryOtp');

const COMMANDS = {
  ARRIVE_PICKUP: 'ARRIVE_PICKUP',
  VERIFY_PICKUP_OTP: 'VERIFY_PICKUP_OTP',
  START_DELIVERY: 'START_DELIVERY',
  ARRIVE_DROP: 'ARRIVE_DROP',
  REQUEST_DROP_OTP: 'REQUEST_DROP_OTP',
  COMPLETE_DELIVERY: 'COMPLETE_DELIVERY',
  CANCEL_BEFORE_PICKUP: 'CANCEL_BEFORE_PICKUP',
};

const bookingInclude = {
  pickupAddress: true,
  deliveryAddress: true,
  user: { select: { id: true, name: true, email: true, phone: true, profileImage: true } },
};

function lifecycleError(message, statusCode = 400, failureCode = 'INVALID_LIFECYCLE_COMMAND') {
  const err = new AppError(message, statusCode);
  err.failureCode = failureCode;
  return err;
}

function toDriverStatus(bookingStatus) {
  switch (bookingStatus) {
    case 'SEARCHING_DRIVER': return 'PENDING';
    case 'DRIVER_ASSIGNED': return 'ACCEPTED';
    case 'DRIVER_ARRIVED': return 'ARRIVED_AT_PICKUP';
    case 'PICKUP_DONE': return 'PICKED_UP';
    case 'IN_TRANSIT': return 'IN_TRANSIT';
    case 'ARRIVED_AT_DROP': return 'ARRIVED_AT_DROP';
    case 'DELIVERED': return 'DELIVERED';
    case 'CANCELLED': return 'CANCELLED';
    default: return 'PENDING';
  }
}

function toDeliveryJob(booking) {
  const expiresAt = new Date(booking.createdAt.getTime() + OFFER_EXPIRY_MS);
  const proofConfirmed = !!booking.deliveryProofUrl || !!booking.deliveryOtpVerifiedAt || !!booking.deliveredAt;
  return {
    id: booking.id,
    displayOrderId: booking.orderCode || booking.id,
    status: toDriverStatus(booking.status),
    pickup: {
      address: booking.pickupAddress.address,
      shortAddress: booking.pickupAddress.label || booking.pickupAddress.address.split(',')[0],
      latitude: booking.pickupAddress.latitude,
      longitude: booking.pickupAddress.longitude,
      contactName: booking.pickupAddress.contactName,
      contactPhone: booking.pickupAddress.contactPhone,
      instructions: booking.pickupAddress.landmark || '',
    },
    dropoff: {
      address: booking.deliveryAddress.address,
      shortAddress: booking.deliveryAddress.label || booking.deliveryAddress.address.split(',')[0],
      latitude: booking.deliveryAddress.latitude,
      longitude: booking.deliveryAddress.longitude,
      contactName: booking.deliveryAddress.contactName,
      contactPhone: booking.deliveryAddress.contactPhone,
      contactEmail: booking.deliveryAddress.contactEmail || '',
      instructions: booking.deliveryAddress.landmark || '',
    },
    customerName: booking.user?.name || '',
    customerEmail: booking.user?.email || '',
    customerPhone: booking.user?.phone || '',
    packageType: booking.vehicleType,
    packageSize: 'MEDIUM',
    estimatedEarnings: driverEarningFromGross(booking.finalPrice || booking.estimatedPrice).driverAmount,
    distance: booking.distance,
    estimatedDuration: booking.duration,
    createdAt: booking.createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    scheduledAt: booking.scheduledTime?.toISOString() || null,
    acceptedAt: null,
    pickedUpAt: null,
    deliveredAt: booking.deliveredAt?.toISOString() || null,
    completedAt: booking.deliveredAt?.toISOString() || null,
    notes: '',
    proofOfDelivery: proofConfirmed
      ? {
        photoUrl: booking.deliveryProofUrl || null,
        signatureUrl: null,
        otpCode: null,
        deliveredAt: booking.deliveredAt?.toISOString() || null,
        recipientName: booking.deliveryAddress?.contactName || booking.user?.name || null,
      }
      : null,
  };
}

function allowedCommandsFor(status) {
  switch (status) {
    case 'DRIVER_ASSIGNED':
      return [COMMANDS.ARRIVE_PICKUP, COMMANDS.CANCEL_BEFORE_PICKUP];
    case 'DRIVER_ARRIVED':
      return [COMMANDS.VERIFY_PICKUP_OTP, COMMANDS.CANCEL_BEFORE_PICKUP];
    case 'PICKUP_DONE':
      return [COMMANDS.START_DELIVERY];
    case 'IN_TRANSIT':
      return [COMMANDS.ARRIVE_DROP];
    case 'ARRIVED_AT_DROP':
      return [COMMANDS.REQUEST_DROP_OTP, COMMANDS.COMPLETE_DELIVERY];
    default:
      return [];
  }
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveLocation(payloadLocation, driver) {
  const latitude = numberOrNull(payloadLocation?.latitude);
  const longitude = numberOrNull(payloadLocation?.longitude);
  if (latitude != null && longitude != null) {
    return {
      latitude,
      longitude,
      accuracyMeters: numberOrNull(payloadLocation?.accuracyMeters),
      capturedAt: payloadLocation?.capturedAt || null,
      source: 'payload',
    };
  }

  const driverLatitude = numberOrNull(driver?.currentLatitude);
  const driverLongitude = numberOrNull(driver?.currentLongitude);
  if (driverLatitude != null && driverLongitude != null && (driverLatitude !== 0 || driverLongitude !== 0)) {
    return {
      latitude: driverLatitude,
      longitude: driverLongitude,
      accuracyMeters: null,
      capturedAt: null,
      source: 'driver_last_known',
    };
  }
  return null;
}

function expectedCoordinateFor(command, booking) {
  if ([COMMANDS.ARRIVE_PICKUP, COMMANDS.VERIFY_PICKUP_OTP, COMMANDS.CANCEL_BEFORE_PICKUP].includes(command)) {
    return booking.pickupAddress;
  }
  if ([COMMANDS.ARRIVE_DROP, COMMANDS.REQUEST_DROP_OTP, COMMANDS.COMPLETE_DELIVERY].includes(command)) {
    return booking.deliveryAddress;
  }
  return null;
}

function locationEvidenceFor(command, booking, payloadLocation, driver) {
  const location = resolveLocation(payloadLocation, driver);
  if (!location) return null;
  const expected = expectedCoordinateFor(command, booking);
  const expectedLat = numberOrNull(expected?.latitude);
  const expectedLng = numberOrNull(expected?.longitude);
  const distanceToExpectedMeters = expectedLat != null && expectedLng != null
    ? Math.round(haversineKm(location.latitude, location.longitude, expectedLat, expectedLng) * 1000)
    : null;
  return { ...location, distanceToExpectedMeters };
}

async function createLifecycleEvent(client, event) {
  if (!client?.deliveryLifecycleEvent?.create) return null;
  return client.deliveryLifecycleEvent.create({ data: event });
}

async function recordFailure({ booking, actor, command, locationEvidence, error, metadata }) {
  if (!booking) return;
  await createLifecycleEvent(prisma, {
    bookingId: booking.id,
    actorType: actor.actorType,
    actorId: actor.actorId,
    command,
    fromStatus: booking.status,
    toStatus: booking.status,
    success: false,
    failureCode: error.failureCode || 'LIFECYCLE_COMMAND_FAILED',
    message: error.message,
    latitude: locationEvidence?.latitude ?? null,
    longitude: locationEvidence?.longitude ?? null,
    accuracyMeters: locationEvidence?.accuracyMeters ?? null,
    distanceToExpectedMeters: locationEvidence?.distanceToExpectedMeters ?? null,
    metadata: metadata || {},
  });
}

function resultPayload({ booking, message, otpInfo = null, locationEvidence = null }) {
  return {
    job: toDeliveryJob(booking),
    allowedCommands: allowedCommandsFor(booking.status),
    otpInfo,
    locationEvidence,
    message,
  };
}

async function loadBooking(bookingId) {
  return prisma.booking.findUnique({ where: { id: bookingId }, include: bookingInclude });
}

function assertActorCanAccessBooking(booking, actor) {
  if (actor.actorType === 'DRIVER' && booking.driverId !== actor.actorId) {
    throw lifecycleError('Not authorized', 403, 'NOT_AUTHORIZED');
  }
  if (actor.actorType === 'USER' && booking.userId !== actor.actorId) {
    throw lifecycleError('Not authorized', 403, 'NOT_AUTHORIZED');
  }
}

function assertStatus(booking, expected, command) {
  if (booking.status !== expected) {
    throw lifecycleError(
      `${command} is only allowed from ${expected}`,
      400,
      'INVALID_STATUS_FOR_COMMAND'
    );
  }
}

async function updateStatusCommand({ booking, actor, command, toStatus, locationEvidence, message }) {
  if (booking.status === toStatus) {
    return resultPayload({ booking, message, locationEvidence });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const changed = await tx.booking.update({
      where: { id: booking.id },
      data: { status: toStatus },
      include: bookingInclude,
    });
    await recordAudit(tx, {
      actor: { actorId: actor.actorId, actorType: actor.actorType },
      action: 'BOOKING_STATUS_CHANGED',
      entityType: 'Booking',
      entityId: booking.id,
      oldValue: { status: booking.status },
      newValue: { status: toStatus },
    });
    await createLifecycleEvent(tx, {
      bookingId: booking.id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      command,
      fromStatus: booking.status,
      toStatus,
      success: true,
      message,
      latitude: locationEvidence?.latitude ?? null,
      longitude: locationEvidence?.longitude ?? null,
      accuracyMeters: locationEvidence?.accuracyMeters ?? null,
      distanceToExpectedMeters: locationEvidence?.distanceToExpectedMeters ?? null,
      metadata: {},
    });
    return changed;
  });

  await notifyUserBookingEvent(updated, toStatus);
  return resultPayload({ booking: updated, message, locationEvidence });
}

async function requestDropOtp({ booking, actor, payload, locationEvidence }) {
  const forceResend = payload?.forceResend === true;
  const now = new Date();
  const recipientEmail = booking.deliveryAddress?.contactEmail || booking.user?.email || '';
  const isAdminDispatch = booking.dispatchSource === 'ADMIN';
  if (!isAdminDispatch && !recipientEmail) {
    throw lifecycleError('Recipient email is required to send delivery OTP', 400, 'RECIPIENT_EMAIL_REQUIRED');
  }

  const existingWindow = deliveryOtpWindow(booking.deliveryOtpSentAt, now);
  const hasActiveAdminOtp = isAdminDispatch && booking.deliveryOtp && existingWindow.active;
  const hasActiveEmailOtp = !isAdminDispatch && booking.deliveryOtpSentAt && existingWindow.active;
  if (!forceResend && (hasActiveAdminOtp || hasActiveEmailOtp)) {
    const otpInfo = deliveryOtpPayload({
      booking,
      recipientEmail,
      now,
      adminOtp: isAdminDispatch ? booking.deliveryOtp : null,
      alreadySent: true,
    });
    await createLifecycleEvent(prisma, {
      bookingId: booking.id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      command: COMMANDS.REQUEST_DROP_OTP,
      fromStatus: booking.status,
      toStatus: booking.status,
      success: true,
      message: recipientEmail ? `OTP already sent for ${maskEmail(recipientEmail)}` : 'OTP already generated',
      latitude: locationEvidence?.latitude ?? null,
      longitude: locationEvidence?.longitude ?? null,
      accuracyMeters: locationEvidence?.accuracyMeters ?? null,
      distanceToExpectedMeters: locationEvidence?.distanceToExpectedMeters ?? null,
      metadata: { alreadySent: true },
    });
    return resultPayload({
      booking,
      otpInfo,
      locationEvidence,
      message: recipientEmail ? `OTP already sent for ${maskEmail(recipientEmail)}` : 'OTP already generated',
    });
  }

  if (forceResend && booking.deliveryOtpSentAt && !existingWindow.canResend) {
    const otpInfo = deliveryOtpPayload({
      booking,
      recipientEmail,
      now,
      adminOtp: isAdminDispatch ? booking.deliveryOtp : null,
      alreadySent: true,
    });
    return resultPayload({
      booking,
      otpInfo,
      locationEvidence,
      message: `OTP can be resent after ${existingWindow.resendAvailableAt.toISOString()}`,
    });
  }

  const generatedOtp = generateDeliveryOtp();
  const updated = await prisma.booking.update({
    where: { id: booking.id },
    data: {
      deliveryOtpSentAt: now,
      deliveryOtpVerifiedAt: null,
      deliveryOtp: isAdminDispatch ? generatedOtp : '',
    },
    include: bookingInclude,
  });

  if (!isAdminDispatch && recipientEmail) {
    await sendEmailOtp(recipientEmail);
  }

  const message = recipientEmail ? `OTP sent for ${maskEmail(recipientEmail)}` : 'OTP generated (recipient email missing)';
  await createLifecycleEvent(prisma, {
    bookingId: booking.id,
    actorType: actor.actorType,
    actorId: actor.actorId,
    command: COMMANDS.REQUEST_DROP_OTP,
    fromStatus: booking.status,
    toStatus: updated.status,
    success: true,
    message,
    latitude: locationEvidence?.latitude ?? null,
    longitude: locationEvidence?.longitude ?? null,
    accuracyMeters: locationEvidence?.accuracyMeters ?? null,
    distanceToExpectedMeters: locationEvidence?.distanceToExpectedMeters ?? null,
    metadata: { recipientEmail: recipientEmail ? maskEmail(recipientEmail) : '', dispatchSource: booking.dispatchSource },
  });
  await notifyUserBookingEvent(updated, 'DELIVERY_OTP_REQUESTED');

  return resultPayload({
    booking: updated,
    otpInfo: deliveryOtpPayload({
      booking: updated,
      recipientEmail,
      now,
      adminOtp: isAdminDispatch ? generatedOtp : null,
      alreadySent: false,
    }),
    locationEvidence,
    message,
  });
}

async function completeDelivery({ booking, actor, payload, locationEvidence }) {
  if (booking.status === 'DELIVERED') {
    if (!isSettlementEligible(booking)) {
      throw lifecycleError('Delivered booking is missing handover verification', 409, 'DELIVERED_NOT_SETTLED');
    }
    return resultPayload({ booking, message: 'Delivery already completed', locationEvidence });
  }

  assertStatus(booking, 'ARRIVED_AT_DROP', COMMANDS.COMPLETE_DELIVERY);

  const otp = payload?.otp || payload?.otpCode || payload?.proof?.otpCode;
  if (!otp || String(otp).trim().length < 4) {
    throw lifecycleError('Recipient OTP is required', 400, 'RECIPIENT_OTP_REQUIRED');
  }
  const proof = payload?.proof || {};
  const photoUrl = proof.photoUrl || payload?.photoUrl || null;
  const recipientName = proof.recipientName || payload?.recipientName || null;
  if (!photoUrl && !recipientName) {
    throw lifecycleError('Proof photo or recipient name is required', 400, 'PROOF_REQUIRED');
  }
  const otpWindow = deliveryOtpWindow(booking.deliveryOtpSentAt);
  if (!booking.deliveryOtpSentAt || !otpWindow.active) {
    throw lifecycleError('Recipient OTP expired. Please resend the OTP.', 400, 'RECIPIENT_OTP_EXPIRED');
  }

  const recipientEmail = booking.deliveryAddress?.contactEmail || booking.user?.email || '';
  const otpResult = actor.actorType === 'USER'
    ? await verifyUserDeliveryOtp({ booking, otp, recipientEmail })
    : await verifyDeliveryOtp({ booking, otp, recipientEmail });
  if (!otpResult.valid) {
    throw lifecycleError(otpResult.error, 400, 'RECIPIENT_OTP_INVALID');
  }

  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const deliverResult = await tx.booking.updateMany({
      where: {
        id: booking.id,
        status: { not: 'DELIVERED' },
      },
      data: {
        status: 'DELIVERED',
        deliveryProofUrl: photoUrl,
        deliveryOtp: '',
        deliveryOtpVerifiedAt: now,
        deliveredAt: now,
        paymentStatus: 'COMPLETED',
      },
    });

    const deliveredBooking = await tx.booking.findUnique({
      where: { id: booking.id },
      include: bookingInclude,
    });
    if (!deliveredBooking) throw lifecycleError('Job not found', 404, 'BOOKING_NOT_FOUND');
    if (deliverResult.count !== 1) return deliveredBooking;

    await tx.order.upsert({
      where: { bookingId: booking.id },
      update: { completedAt: now },
      create: { bookingId: booking.id, completedAt: now },
    });

    if (booking.driverId) {
      await creditDriverEarning(tx, booking.driverId, deliveredBooking);
      await tx.driver.update({
        where: { id: booking.driverId },
        data: { totalTrips: { increment: 1 } },
      });
    }

    await recordAudit(tx, {
      actor: { actorId: actor.actorId, actorType: actor.actorType },
      action: 'BOOKING_DELIVERED',
      entityType: 'Booking',
      entityId: booking.id,
      oldValue: { status: booking.status },
      newValue: {
        status: 'DELIVERED',
        deliveryProofUrl: photoUrl,
        recipientName,
        deliveredAt: now.toISOString(),
      },
    });
    await createLifecycleEvent(tx, {
      bookingId: booking.id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      command: COMMANDS.COMPLETE_DELIVERY,
      fromStatus: booking.status,
      toStatus: 'DELIVERED',
      success: true,
      message: 'Delivery completed',
      latitude: locationEvidence?.latitude ?? null,
      longitude: locationEvidence?.longitude ?? null,
      accuracyMeters: locationEvidence?.accuracyMeters ?? null,
      distanceToExpectedMeters: locationEvidence?.distanceToExpectedMeters ?? null,
      metadata: { proof: { photoUrl, recipientName } },
    });
    return deliveredBooking;
  });

  await notifyUserBookingEvent(updated, 'DELIVERED');
  return resultPayload({ booking: updated, message: 'Delivery completed', locationEvidence });
}

async function cancelBeforePickup({ booking, actor, locationEvidence }) {
  if (['PICKUP_DONE', 'IN_TRANSIT', 'ARRIVED_AT_DROP', 'DELIVERED', 'CANCELLED'].includes(booking.status)) {
    throw lifecycleError('Cannot cancel after picking up the package', 400, 'CANCEL_NOT_ALLOWED');
  }
  const updated = await prisma.$transaction(async (tx) => {
    const changed = await tx.booking.update({
      where: { id: booking.id },
      data: { status: 'SEARCHING_DRIVER', driverId: null },
      include: bookingInclude,
    });
    await recordAudit(tx, {
      actor: { actorId: actor.actorId, actorType: actor.actorType },
      action: 'BOOKING_DRIVER_CANCELLED',
      entityType: 'Booking',
      entityId: booking.id,
      oldValue: { status: booking.status, driverId: booking.driverId },
      newValue: { status: 'SEARCHING_DRIVER', driverId: null },
    });
    await createLifecycleEvent(tx, {
      bookingId: booking.id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      command: COMMANDS.CANCEL_BEFORE_PICKUP,
      fromStatus: booking.status,
      toStatus: 'SEARCHING_DRIVER',
      success: true,
      message: 'Job cancelled before pickup',
      latitude: locationEvidence?.latitude ?? null,
      longitude: locationEvidence?.longitude ?? null,
      accuracyMeters: locationEvidence?.accuracyMeters ?? null,
      distanceToExpectedMeters: locationEvidence?.distanceToExpectedMeters ?? null,
      metadata: {},
    });
    return changed;
  });
  return resultPayload({ booking: updated, message: 'Job cancelled before pickup', locationEvidence });
}

async function executeDriverLifecycleCommand({ bookingId, driver, command, payload = {} }) {
  const actor = { actorType: 'DRIVER', actorId: driver.id };
  return executeLifecycleCommand({ bookingId, actor, driver, command, payload });
}

async function executeUserLifecycleCommand({ bookingId, user, command, payload = {} }) {
  const actor = { actorType: 'USER', actorId: user.userId || user.id };
  return executeLifecycleCommand({ bookingId, actor, command, payload });
}

async function executeLifecycleCommand({ bookingId, actor, driver, command, payload = {} }) {
  const normalizedCommand = String(command || '').trim().toUpperCase();
  if (!Object.values(COMMANDS).includes(normalizedCommand)) {
    throw lifecycleError(`Invalid lifecycle command: ${command}`, 400, 'UNKNOWN_COMMAND');
  }

  const booking = await loadBooking(bookingId);
  if (!booking) throw lifecycleError('Job not found', 404, 'BOOKING_NOT_FOUND');
  const locationEvidence = locationEvidenceFor(normalizedCommand, booking, payload.location, driver);

  try {
    assertActorCanAccessBooking(booking, actor);

    switch (normalizedCommand) {
      case COMMANDS.ARRIVE_PICKUP:
        if (booking.status === 'DRIVER_ARRIVED') {
          return resultPayload({ booking, message: 'Already arrived at pickup', locationEvidence });
        }
        assertStatus(booking, 'DRIVER_ASSIGNED', normalizedCommand);
        return updateStatusCommand({
          booking,
          actor,
          command: normalizedCommand,
          toStatus: 'DRIVER_ARRIVED',
          locationEvidence,
          message: 'Arrived at pickup',
        });

      case COMMANDS.VERIFY_PICKUP_OTP: {
        if (booking.status === 'PICKUP_DONE') {
          return resultPayload({ booking, message: 'Pickup already verified', locationEvidence });
        }
        assertStatus(booking, 'DRIVER_ARRIVED', normalizedCommand);
        const otp = payload.otp || payload.pickupOtp;
        if (!otp) throw lifecycleError('OTP is required', 400, 'PICKUP_OTP_REQUIRED');
        if (booking.otp !== String(otp).trim()) {
          throw lifecycleError('Invalid OTP', 400, 'PICKUP_OTP_INVALID');
        }
        const updated = await prisma.$transaction(async (tx) => {
          const changed = await tx.booking.update({
            where: { id: booking.id },
            data: { status: 'PICKUP_DONE', otp: '' },
            include: bookingInclude,
          });
          await recordAudit(tx, {
            actor: { actorId: actor.actorId, actorType: actor.actorType },
            action: 'BOOKING_STATUS_CHANGED',
            entityType: 'Booking',
            entityId: booking.id,
            oldValue: { status: booking.status },
            newValue: { status: 'PICKUP_DONE' },
          });
          await createLifecycleEvent(tx, {
            bookingId: booking.id,
            actorType: actor.actorType,
            actorId: actor.actorId,
            command: normalizedCommand,
            fromStatus: booking.status,
            toStatus: 'PICKUP_DONE',
            success: true,
            message: 'Pickup OTP verified',
            latitude: locationEvidence?.latitude ?? null,
            longitude: locationEvidence?.longitude ?? null,
            accuracyMeters: locationEvidence?.accuracyMeters ?? null,
            distanceToExpectedMeters: locationEvidence?.distanceToExpectedMeters ?? null,
            metadata: {},
          });
          return changed;
        });
        await notifyUserBookingEvent(updated, 'PICKUP_DONE');
        return resultPayload({ booking: updated, message: 'Pickup OTP verified', locationEvidence });
      }

      case COMMANDS.START_DELIVERY:
        if (['IN_TRANSIT', 'ARRIVED_AT_DROP'].includes(booking.status)) {
          return resultPayload({ booking, message: 'Delivery already started', locationEvidence });
        }
        assertStatus(booking, 'PICKUP_DONE', normalizedCommand);
        return updateStatusCommand({
          booking,
          actor,
          command: normalizedCommand,
          toStatus: 'IN_TRANSIT',
          locationEvidence,
          message: 'Delivery started',
        });

      case COMMANDS.ARRIVE_DROP:
        if (booking.status === 'ARRIVED_AT_DROP') {
          return resultPayload({ booking, message: 'Already arrived at drop-off', locationEvidence });
        }
        assertStatus(booking, 'IN_TRANSIT', normalizedCommand);
        return updateStatusCommand({
          booking,
          actor,
          command: normalizedCommand,
          toStatus: 'ARRIVED_AT_DROP',
          locationEvidence,
          message: 'Arrived at drop-off',
        });

      case COMMANDS.REQUEST_DROP_OTP:
        assertStatus(booking, 'ARRIVED_AT_DROP', normalizedCommand);
        return requestDropOtp({ booking, actor, payload, locationEvidence });

      case COMMANDS.COMPLETE_DELIVERY:
        return completeDelivery({ booking, actor, payload, locationEvidence });

      case COMMANDS.CANCEL_BEFORE_PICKUP:
        return cancelBeforePickup({ booking, actor, locationEvidence });

      default:
        throw lifecycleError(`Invalid lifecycle command: ${command}`, 400, 'UNKNOWN_COMMAND');
    }
  } catch (err) {
    if (err.statusCode) {
      await recordFailure({
        booking,
        actor,
        command: normalizedCommand,
        locationEvidence,
        error: err,
        metadata: { payloadKeys: Object.keys(payload || {}) },
      });
    }
    throw err;
  }
}

module.exports = {
  COMMANDS,
  bookingInclude,
  toDeliveryJob,
  toDriverStatus,
  allowedCommandsFor,
  executeDriverLifecycleCommand,
  executeUserLifecycleCommand,
  executeLifecycleCommand,
};
