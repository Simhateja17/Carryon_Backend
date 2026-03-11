const { Router } = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const prisma = require('../lib/prisma');
const { authenticateDriver, requireDriver } = require('../middleware/driverAuth');
const { AppError } = require('../middleware/errorHandler');

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

let _supabase;
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  }
  return _supabase;
}

// POST /api/driver/documents — upload a document
router.post('/', upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) return next(new AppError('No image file provided', 400));
    const { type } = req.body;
    if (!type) return next(new AppError('Document type is required', 400));

    const validTypes = ['DRIVERS_LICENSE', 'VEHICLE_REGISTRATION', 'INSURANCE', 'PROFILE_PHOTO', 'ID_PROOF'];
    if (!validTypes.includes(type)) {
      return next(new AppError('Invalid document type', 400));
    }

    const ext = req.file.originalname.split('.').pop() || 'jpg';
    const fileName = `driver-documents/${req.driver.id}/${type}_${Date.now()}.${ext}`;

    const { error } = await getSupabase().storage
      .from('driver-documents')
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true,
      });

    if (error) {
      console.error('Supabase upload error:', error);
      return next(new AppError('Failed to upload document', 500));
    }

    const { data: urlData } = getSupabase().storage
      .from('driver-documents')
      .getPublicUrl(fileName);

    const document = await prisma.driverDocument.upsert({
      where: { driverId_type: { driverId: req.driver.id, type } },
      update: { imageUrl: urlData.publicUrl, status: 'PENDING', rejectionReason: null },
      create: { driverId: req.driver.id, type, imageUrl: urlData.publicUrl },
    });

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

    const { error } = await getSupabase().storage
      .from('driver-documents')
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true,
      });

    if (error) return next(new AppError('Failed to upload document', 500));

    const { data: urlData } = getSupabase().storage
      .from('driver-documents')
      .getPublicUrl(fileName);

    const updated = await prisma.driverDocument.update({
      where: { id: req.params.id },
      data: { imageUrl: urlData.publicUrl, status: 'PENDING', rejectionReason: null },
    });

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
