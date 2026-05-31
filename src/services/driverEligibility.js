const prisma = require('../lib/prisma');
const { assertDriverInServiceArea } = require('./geoFence');
const {
  REQUIRED_DRIVER_ELIGIBILITY_DOCUMENT_TYPES,
  missingApprovedDocumentTypes,
} = require('../lib/driverOnboardingRequirements');

const REQUIRED_DOCUMENT_TYPES = new Set(REQUIRED_DRIVER_ELIGIBILITY_DOCUMENT_TYPES);

function parseExpiryDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function isExpiredDocument(document, now = new Date()) {
  const expiry = parseExpiryDate(document?.expiryDate);
  return !!expiry && expiry < now;
}

function documentExpiryReminderDays(document, now = new Date()) {
  const expiry = parseExpiryDate(document?.expiryDate);
  if (!expiry) return null;
  const msRemaining = expiry.getTime() - now.getTime();
  if (msRemaining < 0) return 0;
  return Math.ceil(msRemaining / (24 * 60 * 60 * 1000));
}

function documentLabel(type) {
  return String(type || '').replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildEligibilityBlockers(driver, missingRequiredDocuments, expiredDocuments) {
  const blockers = [];
  if (driver?.isVerified !== true || driver?.verificationStatus !== 'APPROVED') {
    blockers.push({
      code: 'ADMIN_APPROVAL_REQUIRED',
      message: 'Admin approval is required before the driver can go online.',
    });
  }
  for (const type of missingRequiredDocuments) {
    blockers.push({
      code: 'REQUIRED_DOCUMENT_MISSING',
      documentType: type,
      message: `${documentLabel(type)} must be approved before the driver can go online.`,
    });
  }
  for (const type of expiredDocuments) {
    blockers.push({
      code: 'REQUIRED_DOCUMENT_EXPIRED',
      documentType: type,
      message: `${documentLabel(type)} has expired and must be renewed before the driver can go online.`,
    });
  }
  if (driverOnlineRequiresStripePayouts() && driver?.stripePayoutsEnabled !== true) {
    blockers.push({
      code: 'STRIPE_PAYOUTS_DISABLED',
      message: driver?.stripeConnectAccountId
        ? 'Stripe payout setup is incomplete or payouts are disabled.'
        : 'Driver must complete Stripe payout setup before going online.',
    });
  }
  return blockers;
}

function driverOnlineRequiresStripePayouts() {
  return process.env.DRIVER_ONLINE_REQUIRES_STRIPE_PAYOUTS !== 'false';
}

function readinessStatusFor(blockers) {
  if (blockers.length === 0) return 'READY_TO_GO_ONLINE';
  const codes = new Set(blockers.map((blocker) => blocker.code));
  if (codes.has('ADMIN_APPROVAL_REQUIRED')) return 'ADMIN_REVIEW_REQUIRED';
  if (codes.has('REQUIRED_DOCUMENT_EXPIRED')) return 'DOCUMENTS_EXPIRED';
  if (codes.has('REQUIRED_DOCUMENT_MISSING')) return 'DOCUMENTS_REQUIRED';
  if (codes.has('STRIPE_PAYOUTS_DISABLED')) return 'PAYOUT_SETUP_REQUIRED';
  return 'NOT_READY';
}

function readinessLabelFor(status) {
  switch (status) {
    case 'READY_TO_GO_ONLINE':
      return 'Ready to go online';
    case 'ADMIN_REVIEW_REQUIRED':
      return 'Admin review required';
    case 'DOCUMENTS_EXPIRED':
      return 'Document expired';
    case 'DOCUMENTS_REQUIRED':
      return 'Documents required';
    case 'PAYOUT_SETUP_REQUIRED':
      return 'Payout setup required';
    default:
      return 'Not ready';
  }
}

function evaluateDriverEligibility(driver, now = new Date()) {
  const documents = driver?.documents || [];
  const approvedByType = new Map(
    documents
      .filter((document) => document.status === 'APPROVED')
      .map((document) => [document.type, document])
  );

  const missingRequiredDocuments = missingApprovedDocumentTypes(documents);
  const expiredDocuments = [];

  for (const type of REQUIRED_DOCUMENT_TYPES) {
    const document = approvedByType.get(type);
    if (!document) {
      continue;
    }
    if (isExpiredDocument(document, now)) {
      expiredDocuments.push(type);
    }
  }

  const blockers = buildEligibilityBlockers(driver, missingRequiredDocuments, expiredDocuments);
  const status = readinessStatusFor(blockers);

  return {
    canGoOnline: blockers.length === 0,
    status,
    label: readinessLabelFor(status),
    blockers,
    primaryBlocker: blockers[0] || null,
    missingRequiredDocuments,
    expiredDocuments,
    payoutRequirements: {
      stripeAccountId: driver?.stripeConnectAccountId || null,
      detailsSubmitted: driver?.stripeDetailsSubmitted === true,
      payoutsEnabled: driver?.stripePayoutsEnabled === true,
      requirements: driver?.stripeRequirements || null,
    },
  };
}

function normalizeEligibilityLocation(location) {
  if (!location) return null;
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude === 0 && longitude === 0) return null;
  return { latitude, longitude };
}

async function assertDriverCanGoOnline(
  driverId,
  {
    db = prisma,
    now = new Date(),
    driverLocation = null,
    serviceAreaCheck = assertDriverInServiceArea,
  } = {}
) {
  const driver = await db.driver.findUnique({
    where: { id: driverId },
    include: { documents: true },
  });
  const eligibility = evaluateDriverEligibility(driver, now);
  if (!eligibility.canGoOnline) {
    const err = new Error('Driver cannot go online until required documents are approved, unexpired, and Stripe payouts are enabled.');
    err.statusCode = 403;
    err.details = eligibility;
    throw err;
  }

  const location = normalizeEligibilityLocation(driverLocation) || normalizeEligibilityLocation({
    latitude: driver?.currentLatitude,
    longitude: driver?.currentLongitude,
  });
  if (!location) {
    const err = new Error('Current location is required to go online.');
    err.statusCode = 400;
    throw err;
  }
  await serviceAreaCheck(location.latitude, location.longitude);

  return eligibility;
}

async function applyDocumentExpiryReminders({ db = prisma, now = new Date() } = {}) {
  const documents = await db.driverDocument.findMany({
    where: {
      status: 'APPROVED',
      type: { in: Array.from(REQUIRED_DOCUMENT_TYPES) },
      expiryDate: { not: null },
    },
    include: { driver: true },
  });

  const reminders = [];
  for (const document of documents) {
    const days = documentExpiryReminderDays(document, now);
    if (![30, 14, 3].includes(days)) continue;
    reminders.push({
      driverId: document.driverId,
      title: 'Document expiring soon',
      message: `${document.type.replaceAll('_', ' ')} expires in ${days} day${days === 1 ? '' : 's'}.`,
      type: 'ALERT',
      actionData: JSON.stringify({ documentId: document.id, documentType: document.type, daysUntilExpiry: days }),
    });
  }

  if (reminders.length > 0) {
    await db.driverNotification.createMany({ data: reminders, skipDuplicates: true });
  }

  const expiredDriverIds = new Set(
    documents
      .filter((document) => isExpiredDocument(document, now))
      .map((document) => document.driverId)
  );

  if (expiredDriverIds.size > 0) {
    await db.driver.updateMany({
      where: { id: { in: Array.from(expiredDriverIds) }, isOnline: true },
      data: { isOnline: false },
    });
  }

  return { reminderCount: reminders.length, offlinedDriverCount: expiredDriverIds.size };
}

function startDocumentExpiryLoop({ intervalMs = 24 * 60 * 60 * 1000 } = {}) {
  const timer = setInterval(() => {
    applyDocumentExpiryReminders().catch((err) => {
      console.error('[driver-eligibility] document expiry loop failed:', err);
    });
  }, intervalMs);
  timer.unref?.();
  return timer;
}

module.exports = {
  REQUIRED_DOCUMENT_TYPES,
  applyDocumentExpiryReminders,
  assertDriverCanGoOnline,
  buildEligibilityBlockers,
  documentExpiryReminderDays,
  driverOnlineRequiresStripePayouts,
  evaluateDriverEligibility,
  isExpiredDocument,
  normalizeEligibilityLocation,
  startDocumentExpiryLoop,
};
