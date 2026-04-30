const { Router } = require('express');
const multer = require('multer');
const prisma = require('../lib/prisma');
const { authenticateDriver, requireDriver } = require('../middleware/driverAuth');
const { AppError } = require('../middleware/errorHandler');
const { uploadToSupabase } = require('../lib/supabase');

const router = Router();
router.use(authenticateDriver, requireDriver);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new AppError('Only image files are allowed', 400), false);
    }
  },
});

const VALID_DOCUMENT_TYPES = new Set([
  'DRIVERS_LICENSE',
  'DRIVERS_LICENSE_BACK',
  'GDL',
  'VEHICLE_REGISTRATION',
  'ROAD_TAX',
  'PUSPAKOM',
  'APAD_PERMIT',
  'VEHICLE_PHOTO_FRONT',
  'VEHICLE_PHOTO_BACK',
  'VEHICLE_PHOTO_LEFT',
  'VEHICLE_PHOTO_RIGHT',
  'VEHICLE_PHOTO_INTERIOR',
  'BANK_STATEMENT',
  'POLICE_CLEARANCE',
  'INSURANCE',
  'PROFILE_PHOTO',
  'ID_PROOF',
  'MYKAD_FRONT',
  'MYKAD_BACK',
  'SELFIE',
  'PASSPORT',
  'WORK_PERMIT_PLKS',
]);

// POST /api/driver/documents — upload a document
// Supports two modes:
// 1. Multipart form upload (image file + type) - backend uploads to Supabase
// 2. JSON body with imageUrl + type - image already uploaded to Supabase from mobile app
router.post('/', upload.single('image'), async (req, res, next) => {
  try {
    let imageUrl;
    let type;
    let expiryDate = null;
    console.log('[driver-documents] POST upload — driverId:', req.driver.id);

    // Check if this is a JSON request (image already uploaded to Supabase)
    if (req.is('application/json') || (!req.file && req.body.imageUrl)) {
      // Mode 2: JSON body with imageUrl
      type = req.body.type;
      imageUrl = req.body.imageUrl;
      expiryDate = req.body.expiryDate || null;

      if (!imageUrl) return next(new AppError('imageUrl is required', 400));
      if (!type) return next(new AppError('Document type is required', 400));
    } else {
      // Mode 1: Multipart form upload
      if (!req.file) return next(new AppError('No image file provided', 400));
      type = req.body.type;
      if (!type) return next(new AppError('Document type is required', 400));

      const ext = req.file.originalname.split('.').pop() || 'jpg';
      const fileName = `driver-documents/${req.driver.id}/${type}_${Date.now()}.${ext}`;

      try {
        imageUrl = await uploadToSupabase('driver-documents', req.file, fileName, { upsert: true });
      } catch (error) {
        console.error('Supabase upload error:', error);
        return next(new AppError('Failed to upload document', 500));
      }
    }

    if (!VALID_DOCUMENT_TYPES.has(type)) {
      return next(new AppError('Invalid document type', 400));
    }

    const document = await prisma.driverDocument.upsert({
      where: { driverId_type: { driverId: req.driver.id, type } },
      update: {
        imageUrl,
        expiryDate,
        status: 'PENDING',
        rejectionReason: null,
      },
      create: {
        driverId: req.driver.id,
        type,
        imageUrl,
        expiryDate,
      },
    });
    console.log('[driver-documents] document upserted — driverId:', req.driver.id, 'type:', type, 'docId:', document.id, 'status:', document.status);

    res.status(201).json({ success: true, data: document });
  } catch (err) {
    next(err);
  }
});

// GET /api/driver/documents — list all documents
router.get('/', async (req, res, next) => {
  try {
    const documents = await prisma.driverDocument.findMany({
      where: { driverId: req.driver.id },
      orderBy: { uploadedAt: 'desc' },
    });
    res.json({ success: true, data: documents });
  } catch (err) {
    next(err);
  }
});

// PUT /api/driver/documents/:id — re-upload a rejected document
router.put('/:id', upload.single('image'), async (req, res, next) => {
  try {
    const doc = await prisma.driverDocument.findUnique({ where: { id: req.params.id } });
    if (!doc) return next(new AppError('Document not found', 404));
    if (doc.driverId !== req.driver.id) return next(new AppError('Not authorized', 403));
    if (!req.file) return next(new AppError('No image file provided', 400));

    const ext = req.file.originalname.split('.').pop() || 'jpg';
    const fileName = `driver-documents/${req.driver.id}/${doc.type}_${Date.now()}.${ext}`;

    let publicUrl;
    try {
      publicUrl = await uploadToSupabase('driver-documents', req.file, fileName, { upsert: true });
    } catch (_error) {
      return next(new AppError('Failed to upload document', 500));
    }

    const updated = await prisma.driverDocument.update({
      where: { id: req.params.id },
      data: {
        imageUrl: publicUrl,
        expiryDate: req.body.expiryDate || doc.expiryDate,
        status: 'PENDING',
        rejectionReason: null,
      },
    });

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
