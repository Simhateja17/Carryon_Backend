const prisma = require('../lib/prisma');
const { assertDriverInServiceArea } = require('./geoFence');

const REQUIRED_DOCUMENT_TYPES = new Set([
  'DRIVERS_LICENSE',
  'ROAD_TAX',
  'INSURANCE',
]);

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

function evaluateDriverEligibility(driver, now = new Date()) {
  const documents = driver?.documents || [];
  const approvedByType = new Map(
    documents
      .filter((document) => document.status === 'APPROVED')
      .map((document) => [document.type, document])
  );

  const missingRequiredDocuments = [];
  const expiredDocuments = [];

  for (const type of REQUIRED_DOCUMENT_TYPES) {
    const document = approvedByType.get(type);
    if (!document) {
      missingRequiredDocuments.push(type);
      continue;
    }
    if (isExpiredDocument(document, now)) {
      expiredDocuments.push(type);
    }
  }

  return {
    canGoOnline:
      driver?.isVerified === true &&
      driver?.verificationStatus === 'APPROVED' &&
      missingRequiredDocuments.length === 0 &&
      expiredDocuments.length === 0,
    missingRequiredDocuments,
    expiredDocuments,
  };
}

async function assertDriverCanGoOnline(driverId, { db = prisma, now = new Date() } = {}) {
  const driver = await db.driver.findUnique({
    where: { id: driverId },
    include: { documents: true },
  });
  const eligibility = evaluateDriverEligibility(driver, now);
  if (!eligibility.canGoOnline) {
    const err = new Error('Driver cannot go online until required documents are approved and unexpired.');
    err.statusCode = 403;
    err.details = eligibility;
    throw err;
  }

  if (
    driver &&
    Number.isFinite(driver.currentLatitude) &&
    Number.isFinite(driver.currentLongitude)
  ) {
    await assertDriverInServiceArea(driver.currentLatitude, driver.currentLongitude);
  }

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
  documentExpiryReminderDays,
  evaluateDriverEligibility,
  isExpiredDocument,
  startDocumentExpiryLoop,
};
