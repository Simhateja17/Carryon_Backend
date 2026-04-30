const { Router } = require('express');
const multer = require('multer');
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

// POST /api/driver/upload/package-image
router.post('/package-image', upload.single('image'), async (req, res, next) => {
  try {
    console.log('[driver-upload] POST package-image — driverId:', req.driver.id, 'fileSize:', req.file?.size);
    if (!req.file) {
      return next(new AppError('No image file provided', 400));
    }

    const ext = req.file.originalname.split('.').pop() || 'jpg';
    const fileName = `driver-proofs/${req.driver.id}/${Date.now()}.${ext}`;

    let publicUrl;
    try {
      publicUrl = await uploadToSupabase('package-images', req.file, fileName);
    } catch (error) {
      console.error('[driver-upload] Supabase upload error:', error);
      return next(new AppError('Failed to upload image', 500));
    }

    console.log('[driver-upload] package-image uploaded — driverId:', req.driver.id, 'url:', publicUrl);
    res.json({
      success: true,
      data: { url: publicUrl },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
