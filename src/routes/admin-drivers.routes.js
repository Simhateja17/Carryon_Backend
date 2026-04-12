const { Router } = require('express');
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');

const router = Router();

// GET /api/admin/drivers — list all drivers with document/vehicle counts
router.get('/', async (req, res, next) => {
  try {
    console.log('[admin-drivers] GET /drivers — fetching all drivers');
    const drivers = await prisma.driver.findMany({
      include: {
        documents: { select: { id: true, type: true, status: true } },
        vehicle: { select: { id: true, type: true, make: true, model: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    console.log('[admin-drivers] GET /drivers — returned', drivers.length, 'drivers');
    res.json({
      success: true,
      data: drivers.map((d) => ({
        id: d.id,
        name: d.name,
        email: d.email,
        phone: d.phone,
        photo: d.photo,
        isOnline: d.isOnline,
        isVerified: d.isVerified,
        verificationStatus: d.verificationStatus,
        rating: d.rating,
        totalTrips: d.totalTrips,
        emergencyContact: d.emergencyContact,
        createdAt: d.createdAt,
        documentsCount: d.documents.length,
        documentsApproved: d.documents.filter((doc) => doc.status === 'APPROVED').length,
        hasFcmToken: !!d.fcmToken,
        hasVehicle: !!d.vehicle,
        vehicleSummary: d.vehicle
          ? `${d.vehicle.type} — ${d.vehicle.make} ${d.vehicle.model}`
          : null,
      })),
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
      include: {
        documents: { orderBy: { uploadedAt: 'desc' } },
        vehicle: true,
      },
    });

    if (!driver) {
      return next(new AppError('Driver not found', 404));
    }

    res.json({ success: true, data: driver });
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

    const updated = await prisma.driverDocument.update({
      where: { id: req.params.docId },
      data: {
        status,
        rejectionReason: status === 'REJECTED' ? rejectionReason : null,
      },
    });

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/drivers/:id/verify — update driver verification status
router.put('/:id/verify', async (req, res, next) => {
  try {
    const { verificationStatus } = req.body;
    console.log('[admin-drivers] PUT verify — driverId:', req.params.id, 'verificationStatus:', verificationStatus);
    const validStatuses = ['PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED'];

    if (!verificationStatus || !validStatuses.includes(verificationStatus)) {
      return next(
        new AppError(`verificationStatus must be one of: ${validStatuses.join(', ')}`, 400)
      );
    }

    const driver = await prisma.driver.findUnique({
      where: { id: req.params.id },
    });

    if (!driver) {
      return next(new AppError('Driver not found', 404));
    }

    const updated = await prisma.driver.update({
      where: { id: req.params.id },
      data: {
        verificationStatus,
        isVerified: verificationStatus === 'APPROVED',
      },
      include: { documents: true, vehicle: true },
    });
    console.log('[admin-drivers] verify — driverId:', req.params.id, 'verificationStatus →', updated.verificationStatus, 'isVerified:', updated.isVerified);

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
