const { Router } = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
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
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
  }
  return _supabase;
}

// POST /api/driver/upload/package-image
router.post('/package-image', upload.single('image'), async (req, res, next) => {
  try {
    console.log('[driver-upload] POST package-image — driverId:', req.driver.id, 'fileSize:', req.file?.size);
    if (!req.file) {
      return next(new AppError('No image file provided', 400));
    }

    const ext = req.file.originalname.split('.').pop() || 'jpg';
    const fileName = `driver-proofs/${req.driver.id}/${Date.now()}.${ext}`;

    const { error } = await getSupabase().storage
      .from('package-images')
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });

    if (error) {
      console.error('[driver-upload] Supabase upload error:', error);
      return next(new AppError('Failed to upload image', 500));
    }

    const { data: urlData } = getSupabase().storage
      .from('package-images')
      .getPublicUrl(fileName);

    console.log('[driver-upload] package-image uploaded — driverId:', req.driver.id, 'url:', urlData.publicUrl);
    res.json({
      success: true,
      data: { url: urlData.publicUrl },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
