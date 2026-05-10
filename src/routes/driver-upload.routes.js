const { Router } = require('express');
const multer = require('multer');
const { authenticateDriver, requireDriver } = require('../middleware/driverAuth');
const { AppError } = require('../middleware/errorHandler');
const { uploadToSupabase } = require('../lib/supabase');
const { validateImageMagicBytes } = require('../lib/imageValidation');

const router = Router();
router.use(authenticateDriver, requireDriver);

const allowedImageExtensions = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']);

function looksLikeImage(file) {
  if (!file) return false;
  if (file.mimetype?.startsWith('image/')) return true;
  const ext = (file.originalname || '').split('.').pop()?.toLowerCase();
  return !!ext && allowedImageExtensions.has(ext);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (looksLikeImage(file)) {
      cb(null, true);
    } else {
      cb(new AppError('Only image files are allowed', 400), false);
    }
  },
});

function parseUploadMiddleware(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new AppError('Image must be 10MB or smaller', 400));
    }
    return next(err);
  });
}

// POST /api/driver/upload/package-image
router.post('/package-image', parseUploadMiddleware, async (req, res, next) => {
  const t0 = Date.now();
  try {
    const driverId = req.driver.id;
    const fileSize = req.file?.size;
    const mimetype = req.file?.mimetype;
    const originalname = req.file?.originalname;

    console.log('[driver-upload] POST package-image', JSON.stringify({
      driverId,
      fileSize,
      mimetype,
    }));

    if (!req.file) {
      return next(new AppError('No image file provided', 400));
    }

    const detected = validateImageMagicBytes(req.file);
    if (!detected) {
      return next(new AppError('File is not a valid image', 400));
    }

    const ext = detected.ext;
    const fileName = `driver-proofs/${driverId}/${Date.now()}.${ext}`;

    console.log('[driver-upload] uploading to bucket=package-images');

    let publicUrl;
    try {
      publicUrl = await uploadToSupabase('package-images', req.file, fileName);
    } catch (error) {
      const ms = Date.now() - t0;
      console.error('[driver-upload] UPLOAD FAILED', JSON.stringify({
        driverId,
        durationMs: ms,
        statusCode: error.statusCode || error.status || null,
        isRLS: error.message?.includes('row-level security') || error.statusCode === 403,
        keyConfigured: !!process.env.SUPABASE_SERVICE_KEY,
      }));
      return next(new AppError('Failed to upload image', 500));
    }

    console.log('[driver-upload] UPLOAD OK', JSON.stringify({
      driverId,
      durationMs: Date.now() - t0,
    }));

    res.json({
      success: true,
      data: { url: publicUrl },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
