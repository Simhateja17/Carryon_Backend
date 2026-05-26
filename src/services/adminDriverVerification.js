const { AppError } = require('../middleware/errorHandler');
const { recordAudit } = require('./auditLog');
const {
  REQUIRED_DRIVER_ONBOARDING_DOCUMENT_TYPES,
  missingApprovedDocumentTypes,
} = require('../lib/driverOnboardingRequirements');

const VERIFICATION_DECISIONS = new Set(['PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED']);

const DRIVER_DECISION_INCLUDE = {
  documents: { select: { id: true, type: true, status: true } },
  vehicle: { select: { id: true } },
};

function reviewAdminId(actor = {}) {
  return String(actor.actorId || actor.userId || actor.adminId || actor.driverId || 'system');
}

function driverApprovalBlockers(driver) {
  const blockers = [];
  const docs = driver.documents || [];

  if (!driver.vehicle) {
    blockers.push('Vehicle details must be submitted before approval.');
  }
  const missingRequiredDocs = missingApprovedDocumentTypes(docs, REQUIRED_DRIVER_ONBOARDING_DOCUMENT_TYPES);
  if (missingRequiredDocs.length > 0) {
    blockers.push(`Required approved documents are missing: ${missingRequiredDocs.join(', ')}.`);
  }
  const pendingDocs = docs.filter((doc) => doc.status === 'PENDING').length;
  const rejectedDocs = docs.filter((doc) => doc.status === 'REJECTED').length;
  if (pendingDocs > 0) {
    blockers.push(`${pendingDocs} document${pendingDocs === 1 ? '' : 's'} still pending review.`);
  }
  if (rejectedDocs > 0) {
    blockers.push(`${rejectedDocs} document${rejectedDocs === 1 ? '' : 's'} rejected and must be corrected.`);
  }
  if (!driver.pdpaConsent) {
    blockers.push('PDPA consent is missing.');
  }
  if (!driver.backgroundCheckConsent) {
    blockers.push('Background check consent is missing.');
  }
  if (!driver.noOffencesDeclared) {
    blockers.push('No-offences declaration is missing.');
  }

  return blockers;
}

function normalizeDriverDecisionInput(body = {}) {
  const verificationStatus = body.verificationStatus;
  if (!VERIFICATION_DECISIONS.has(verificationStatus)) {
    throw new AppError(
      `verificationStatus must be one of: ${Array.from(VERIFICATION_DECISIONS).join(', ')}`,
      400
    );
  }

  const rejectionReason = typeof body.rejectionReason === 'string'
    ? body.rejectionReason.trim()
    : '';
  if (verificationStatus === 'REJECTED' && rejectionReason.length < 3) {
    throw new AppError('rejectionReason is required when rejecting a driver', 400);
  }

  return {
    verificationStatus,
    rejectionReason: verificationStatus === 'REJECTED' ? rejectionReason.slice(0, 1000) : null,
  };
}

async function updateDriverVerificationDecision({ db, driverId, body, actor }) {
  const input = normalizeDriverDecisionInput(body);
  const driver = await db.driver.findUnique({
    where: { id: driverId },
    include: DRIVER_DECISION_INCLUDE,
  });

  if (!driver) {
    throw new AppError('Driver not found', 404);
  }

  if (input.verificationStatus === 'APPROVED') {
    const blockers = driverApprovalBlockers(driver);
    if (blockers.length > 0) {
      throw new AppError(`Driver cannot be approved yet: ${blockers.join(' ')}`, 400);
    }
  }

  return db.$transaction(async (tx) => {
    const updated = await tx.driver.update({
      where: { id: driverId },
      data: {
        verificationStatus: input.verificationStatus,
        isVerified: input.verificationStatus === 'APPROVED',
        verificationRejectionReason: input.rejectionReason,
        verificationReviewedAt: new Date(),
        verificationReviewedByAdminId: reviewAdminId(actor),
      },
      include: { documents: true, vehicle: true },
    });

    await recordAudit(tx, {
      actor,
      action: 'DRIVER_VERIFICATION_CHANGED',
      entityType: 'Driver',
      entityId: driverId,
      oldValue: {
        verificationStatus: driver.verificationStatus,
        isVerified: driver.isVerified,
        verificationRejectionReason: driver.verificationRejectionReason,
      },
      newValue: {
        verificationStatus: input.verificationStatus,
        isVerified: input.verificationStatus === 'APPROVED',
        verificationRejectionReason: input.rejectionReason,
      },
    });

    return updated;
  });
}

module.exports = {
  DRIVER_DECISION_INCLUDE,
  VERIFICATION_DECISIONS,
  driverApprovalBlockers,
  normalizeDriverDecisionInput,
  updateDriverVerificationDecision,
};
