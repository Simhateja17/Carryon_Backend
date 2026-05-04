const { Router } = require('express');
const multer = require('multer');
const { authenticate } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { uploadToSupabase } = require('../lib/supabase');

const router = Router();
router.use(authenticate);

const allowedImageExtensions = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']);

function looksLikeImage(file) {
  if (!file) return false;
  if (file.mimetype?.startsWith('image/')) return true;
  const ext = (file.originalname || '').split('.').pop()?.toLowerCase();
  return !!ext && allowedImageExtensions.has(ext);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
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

// POST /api/upload/package-image
router.post('/package-image', parseUploadMiddleware, async (req, res, next) => {
  try {
    console.log('[upload] POST package-image — userId:', req.user.userId, 'fileSize:', req.file?.size);
    if (!req.file) {
      return next(new AppError('No image file provided', 400));
    }

    const ext = req.file.originalname.split('.').pop() || 'jpg';
    const fileName = `packages/${req.user.userId}/${Date.now()}.${ext}`;

    let publicUrl;
    try {
      publicUrl = await uploadToSupabase('package-images', req.file, fileName);
    } catch (error) {
      console.error('Supabase upload error:', error);
      return next(new AppError(`Failed to upload image: ${error.message || 'unknown storage error'}`, 500));
    }

    console.log('[upload] package-image uploaded — userId:', req.user.userId, 'url:', publicUrl);
    res.json({
      success: true,
      data: { url: publicUrl },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
