const { getSignedUrl } = require('../lib/supabase');
const { evaluateDriverEligibility } = require('./driverEligibility');

const REVIEWABLE_VERIFICATION_STATUSES = ['PENDING', 'IN_REVIEW'];

const PII_FIELDS = new Set([
  'mykadNumber',
  'passportNumber',
  'plksNumber',
  'driversLicenseNumber',
  'bankAccountNumber',
  'duitNowId',
  'tngEwalletId',
  'lhdnTaxNumber',
  'sstNumber',
]);

const DRIVER_REVIEW_INCLUDE = {
  documents: { select: { id: true, type: true, status: true, expiryDate: true } },
  vehicle: { select: { id: true, type: true, make: true, model: true } },
  pushDevices: {
    where: { notificationsEnabled: true },
    select: { id: true },
    take: 1,
  },
};

const DRIVER_DETAIL_INCLUDE = {
  documents: { orderBy: { uploadedAt: 'desc' } },
  vehicle: true,
  onboardingSubmissions: {
    orderBy: { submittedAt: 'desc' },
    take: 1,
  },
};

function reviewCandidateWhere() {
  return {
    verificationStatus: { in: REVIEWABLE_VERIFICATION_STATUSES },
  };
}

function reviewCandidateOrderBy() {
  return [
    { onboardingSubmittedAt: { sort: 'desc', nulls: 'last' } },
    { createdAt: 'desc' },
  ];
}

function maskSensitive(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.length <= 4) return '*'.repeat(raw.length);
  return `${'*'.repeat(Math.max(4, raw.length - 4))}${raw.slice(-4)}`;
}

function maskedField(value) {
  return {
    masked: maskSensitive(value),
    hasValue: !!String(value || '').trim(),
  };
}

function driverListProjection(driver) {
  const onlineReadiness = evaluateDriverEligibility(driver);
  return {
    id: driver.id,
    name: driver.name,
    email: driver.email,
    phone: driver.phone,
    photo: driver.photo,
    isOnline: driver.isOnline,
    isVerified: driver.isVerified,
    verificationStatus: driver.verificationStatus,
    verificationRejectionReason: driver.verificationRejectionReason,
    verificationReviewedAt: driver.verificationReviewedAt,
    verificationReviewedByAdminId: driver.verificationReviewedByAdminId,
    rating: driver.rating,
    totalTrips: driver.totalTrips,
    emergencyContact: driver.emergencyContact,
    createdAt: driver.createdAt,
    onboardingSubmittedAt: driver.onboardingSubmittedAt,
    documentsCount: driver.documents.length,
    documentsApproved: driver.documents.filter((doc) => doc.status === 'APPROVED').length,
    documentsPending: driver.documents.filter((doc) => doc.status === 'PENDING').length,
    hasFcmToken: driver.pushDevices.length > 0,
    hasVehicle: !!driver.vehicle,
    vehicleSummary: driver.vehicle
      ? `${driver.vehicle.type} — ${driver.vehicle.make} ${driver.vehicle.model}`.trim()
      : null,
    reviewSource: driver.onboardingSubmittedAt ? 'SUBMITTED_ONBOARDING' : 'LEGACY_UNVERIFIED',
    onlineReadiness,
  };
}

async function signDriverDocuments(driver, { sign = getSignedUrl } = {}) {
  if (!driver.documents) return driver;
  for (const doc of driver.documents) {
    if (doc.imageUrl) {
      try {
        doc.imageUrl = await sign(doc.imageUrl, 3600);
      } catch (_) {
        // Keep original path if signing fails.
      }
    }
  }
  return driver;
}

function detailProjection(driver) {
  const latestSubmission = driver.onboardingSubmissions?.[0] || null;
  const onlineReadiness = evaluateDriverEligibility(driver);
  return {
    id: driver.id,
    name: driver.name,
    email: driver.email,
    phone: driver.phone,
    photo: driver.photo,
    rating: driver.rating,
    totalTrips: driver.totalTrips,
    isOnline: driver.isOnline,
    isVerified: driver.isVerified,
    verificationStatus: driver.verificationStatus,
    verificationRejectionReason: driver.verificationRejectionReason,
    verificationReviewedAt: driver.verificationReviewedAt,
    verificationReviewedByAdminId: driver.verificationReviewedByAdminId,
    emergencyContact: driver.emergencyContact,
    createdAt: driver.createdAt,
    onboardingSubmittedAt: driver.onboardingSubmittedAt,
    reviewSource: driver.onboardingSubmittedAt ? 'SUBMITTED_ONBOARDING' : 'LEGACY_UNVERIFIED',
    onlineReadiness,
    payout: onlineReadiness.payoutRequirements,
    profile: {
      dateOfBirth: driver.dateOfBirth,
      gender: driver.gender,
      language: driver.language,
      nationality: driver.nationality,
      licenseClass: driver.licenseClass,
      licenseExpiry: driver.licenseExpiry,
      hasGDL: driver.hasGDL,
      gdlExpiry: driver.gdlExpiry,
      addressLine1: driver.addressLine1,
      addressLine2: driver.addressLine2,
      city: driver.city,
      postcode: driver.postcode,
      state: driver.state,
      workingStates: driver.workingStates,
      emergencyContactName: driver.emergencyContactName,
      emergencyContactRelation: driver.emergencyContactRelation,
      emergencyContactPhone: driver.emergencyContactPhone,
      bankName: driver.bankName,
      bankAccountHolder: driver.bankAccountHolder,
      pdpaConsent: driver.pdpaConsent,
      backgroundCheckConsent: driver.backgroundCheckConsent,
      agreementVersion: driver.agreementVersion,
      noOffencesDeclared: driver.noOffencesDeclared,
    },
    sensitive: Object.fromEntries(
      Array.from(PII_FIELDS).map((field) => [field, maskedField(driver[field])])
    ),
    documents: driver.documents,
    vehicle: driver.vehicle,
    latestSubmission: latestSubmission
      ? {
          id: latestSubmission.id,
          submittedAt: latestSubmission.submittedAt,
          agreementVersion: latestSubmission.agreementVersion,
        }
      : null,
  };
}

async function listDriverReviewCandidates({ db }) {
  const drivers = await db.driver.findMany({
    where: reviewCandidateWhere(),
    include: DRIVER_REVIEW_INCLUDE,
    orderBy: reviewCandidateOrderBy(),
  });
  return drivers.map(driverListProjection);
}

module.exports = {
  DRIVER_DETAIL_INCLUDE,
  DRIVER_REVIEW_INCLUDE,
  PII_FIELDS,
  REVIEWABLE_VERIFICATION_STATUSES,
  detailProjection,
  driverListProjection,
  listDriverReviewCandidates,
  reviewCandidateOrderBy,
  reviewCandidateWhere,
  signDriverDocuments,
};
