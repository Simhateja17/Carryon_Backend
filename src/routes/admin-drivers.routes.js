const { Router } = require('express');
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { recordAudit } = require('../services/auditLog');
const {
  DRIVER_DETAIL_INCLUDE,
  DRIVER_REVIEW_INCLUDE,
  PII_FIELDS,
  detailProjection,
  driverListProjection,
  listDriverReviewCandidates,
  signDriverDocuments,
} = require('../services/adminDriverReview');
const {
  updateDriverVerificationDecision,
} = require('../services/adminDriverVerification');
const { createAdminDriverRegistration } = require('../services/adminDriverRegistration');

const router = Router();

// GET /api/admin/drivers — list all drivers with document/vehicle counts
router.get('/', async (req, res, next) => {
  try {
    console.log('[admin-drivers] GET /drivers — fetching all drivers');
    const drivers = await prisma.driver.findMany({
      include: DRIVER_REVIEW_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });

    console.log('[admin-drivers] GET /drivers — returned', drivers.length, 'drivers');
    res.json({
      success: true,
      data: drivers.map(driverListProjection),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/drivers/onboarding-queue — drivers that need verification review
router.get('/onboarding-queue', async (req, res, next) => {
  try {
    res.json({
      success: true,
      data: await listDriverReviewCandidates({ db: prisma }),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/drivers — create an admin-started driver registration draft
router.post('/', async (req, res, next) => {
  try {
    const driver = await createAdminDriverRegistration({
      db: prisma,
      body: req.body,
      actor: req.adminActor,
    });

    res.status(201).json({
      success: true,
      data: driverListProjection(driver),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/drivers/:id — get full driver details with documents and vehicle
router.get('/:id', async (req, res, next) => {
  try {
    console.log('[admin-drivers] GET driver detail — driverId:', req.params.id);
    const driver = await prisma.driver.findUnique({
      where: { id: req.params.id },
      include: DRIVER_DETAIL_INCLUDE,
    });

    if (!driver) {
      return next(new AppError('Driver not found', 404));
    }

    await signDriverDocuments(driver);

    res.json({ success: true, data: detailProjection(driver) });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/drivers/:id/pii/reveal — reveal one sensitive field with audit trail
router.post('/:id/pii/reveal', async (req, res, next) => {
  try {
    const { field, reason } = req.body || {};
    if (!PII_FIELDS.has(field)) {
      return next(new AppError('Unsupported sensitive field', 400));
    }
    if (typeof reason !== 'string' || reason.trim().length < 3) {
      return next(new AppError('A reveal reason is required', 400));
    }

    const driver = await prisma.driver.findUnique({
      where: { id: req.params.id },
      select: { id: true, [field]: true },
    });
    if (!driver) return next(new AppError('Driver not found', 404));

    await recordAudit(prisma, {
      actor: req.adminActor,
      action: 'DRIVER_PII_REVEALED',
      entityType: 'Driver',
      entityId: req.params.id,
      newValue: { field, reason: reason.trim().slice(0, 160) },
    });

    res.json({
      success: true,
      data: {
        field,
        value: driver[field] || '',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/drivers/:id/documents/:docId/review — approve or reject a document
router.put('/:id/documents/:docId/review', async (req, res, next) => {
  try {
    const { status, rejectionReason } = req.body;
    console.log('[admin-drivers] PUT document review — driverId:', req.params.id, 'docId:', req.params.docId, 'status:', status);

    if (!status || !['APPROVED', 'REJECTED'].includes(status)) {
      return next(new AppError('status must be APPROVED or REJECTED', 400));
    }

    if (status === 'REJECTED' && !rejectionReason) {
      return next(new AppError('rejectionReason is required when rejecting', 400));
    }

    // Verify the document belongs to this driver
    const doc = await prisma.driverDocument.findFirst({
      where: { id: req.params.docId, driverId: req.params.id },
    });

    if (!doc) {
      return next(new AppError('Document not found for this driver', 404));
    }

    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.driverDocument.update({
        where: { id: req.params.docId },
        data: {
          status,
          rejectionReason: status === 'REJECTED' ? rejectionReason : null,
        },
      });
      await recordAudit(tx, {
        actor: req.adminActor,
        action: 'DRIVER_DOCUMENT_REVIEWED',
        entityType: 'DriverDocument',
        entityId: req.params.docId,
        oldValue: { status: doc.status, rejectionReason: doc.rejectionReason },
        newValue: { status, rejectionReason: status === 'REJECTED' ? rejectionReason : null },
      });
      return changed;
    });

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/drivers/:id/verify — update driver verification status
router.put('/:id/verify', async (req, res, next) => {
  try {
    console.log('[admin-drivers] PUT verify — driverId:', req.params.id, 'verificationStatus:', req.body?.verificationStatus);
    const updated = await updateDriverVerificationDecision({
      db: prisma,
      driverId: req.params.id,
      body: req.body,
      actor: req.adminActor,
    });
    console.log('[admin-drivers] verify — driverId:', req.params.id, 'verificationStatus →', updated.verificationStatus, 'isVerified:', updated.isVerified);

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
