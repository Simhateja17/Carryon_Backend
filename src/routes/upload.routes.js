const { Router } = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { authenticate } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');

const router = Router();
router.use(authenticate);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new AppError('Only image files are allowed', 400), false);
    }
  },
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// POST /api/upload/package-image
router.post('/package-image', upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) {
      return next(new AppError('No image file provided', 400));
    }

    const ext = req.file.originalname.split('.').pop() || 'jpg';
    const fileName = `packages/${req.user.userId}/${Date.now()}.${ext}`;

    const { data, error } = await supabase.storage
      .from('package-images')
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });

    if (error) {
      console.error('Supabase upload error:', error);
      return next(new AppError('Failed to upload image', 500));
    }

    const { data: urlData } = supabase.storage
      .from('package-images')
      .getPublicUrl(fileName);

    res.json({
      success: true,
      data: { url: urlData.publicUrl },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
