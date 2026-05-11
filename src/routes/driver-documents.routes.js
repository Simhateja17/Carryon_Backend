const { Router } = require('express');
const multer = require('multer');
const prisma = require('../lib/prisma');
const { authenticateDriver, requireDriver } = require('../middleware/driverAuth');
const { AppError } = require('../middleware/errorHandler');
const { uploadToSupabase } = require('../lib/supabase');
const { validateImageMagicBytes } = require('../lib/imageValidation');
const { isDriverDocumentPathForDriver } = require('../lib/driverDocumentPaths');
const {
  VALID_DOCUMENT_TYPES,
  fileLooksLikeSupportedDriverDocument,
  uploadDriverDocument,
} = require('../services/driverDocumentUpload');

const router = Router();
router.use(authenticateDriver, requireDriver);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (fileLooksLikeSupportedDriverDocument(file)) {
      cb(null, true);
    } else {
      cb(new AppError('Only image files are allowed', 400), false);
    }
  },
});

function parseDocumentUpload(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new AppError('Image must be 10MB or smaller', 400));
    }
    return next(err);
  });
}

// POST /api/driver/documents — upload a document
// Supports two modes:
// 1. Multipart form upload (image file + type) - backend uploads to Supabase
// 2. JSON body with imageUrl + type - image already uploaded to Supabase from mobile app
router.post('/', parseDocumentUpload, async (req, res, next) => {
  try {
    let imageUrl;
    let type;
    let expiryDate = null;
    console.log('[driver-documents] POST upload — driverId:', req.driver.id);

    // Check if this is a JSON request (image already uploaded to Supabase)
    if (req.is('application/json') || (!req.file && req.body.imageUrl)) {
      // Mode 2: JSON body with object path — mobile uploads to Supabase then sends the path
      type = req.body.type;
      const rawPath = req.body.imageUrl;
      expiryDate = req.body.expiryDate || null;

      if (!rawPath) return next(new AppError('imageUrl is required', 400));
      if (!type) return next(new AppError('Document type is required', 400));

      // Reject HTTP URLs — only accept object paths
      if (rawPath.startsWith('http')) {
        return next(new AppError('Public URLs are not accepted. Submit the storage object path only.', 400));
      }

      // Validate object path belongs to this driver.
      // Canonical format: driver-documents/<driverId>/<documentType>_<timestamp>.<ext>
      // Legacy app builds may send: driver-documents/drivers/<driverId>/<documentType>_<timestamp>.<ext>
      if (!isDriverDocumentPathForDriver(rawPath, req.driver.id)) {
        return next(new AppError('Document path must belong to your driver storage', 403));
      }
      imageUrl = rawPath;
    } else {
      // Mode 1: Multipart form upload
      const document = await uploadDriverDocument({
        driverId: req.driver.id,
        file: req.file,
        type: req.body.type,
        expiryDate: req.body.expiryDate || null,
      });
      console.log('[driver-documents] document upserted — driverId:', req.driver.id, 'type:', document.type, 'status:', document.status);
      return res.status(201).json({ success: true, data: document });
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
    console.log('[driver-documents] document upserted — driverId:', req.driver.id, 'type:', type, 'status:', document.status);

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
router.put('/:id', parseDocumentUpload, async (req, res, next) => {
  try {
    const doc = await prisma.driverDocument.findUnique({ where: { id: req.params.id } });
    if (!doc) return next(new AppError('Document not found', 404));
    if (doc.driverId !== req.driver.id) return next(new AppError('Not authorized', 403));
    if (!req.file) return next(new AppError('No image file provided', 400));

    const detected = validateImageMagicBytes(req.file);
    if (!detected) return next(new AppError('File is not a valid image', 400));

    const ext = detected.ext;
    const fileName = `${req.driver.id}/${doc.type}_${Date.now()}.${ext}`;
    const storageFile = { ...req.file, mimetype: detected.type };

    let publicUrl;
    try {
      publicUrl = await uploadToSupabase('driver-documents', storageFile, fileName, { upsert: true });
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
