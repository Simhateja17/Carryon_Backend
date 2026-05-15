const { Router } = require('express');
const multer = require('multer');
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { uploadToSupabase } = require('../lib/supabase');
const { MAX_ATTACHMENT_BYTES, isAllowedSupportAttachment } = require('../services/supportAttachments');
const {
  addAdminReply,
  assignTicket,
  getSupportTicket,
  listSupportTickets,
  updateTicketStatus,
} = require('../services/adminSupport');

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES },
  fileFilter: (_req, file, cb) => {
    if (isAllowedSupportAttachment(file)) cb(null, true);
    else cb(new AppError('Support attachments must be images or PDFs', 400), false);
  },
});

function parseAttachmentUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(new AppError('Attachment must be 5MB or smaller', 400));
    return next(err);
  });
}

// POST /api/admin/support/attachments
router.post('/attachments', parseAttachmentUpload, async (req, res, next) => {
  try {
    if (!req.file) return next(new AppError('No attachment file provided', 400));
    const ext = req.file.originalname.split('.').pop() || 'bin';
    const actorId = req.adminActor?.actorId || 'admin';
    const path = `admin/${actorId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const fileUrl = await uploadToSupabase('support-attachments', req.file, path);
    res.status(201).json({
      success: true,
      data: {
        fileUrl,
        storagePath: fileUrl,
        mimeType: req.file.mimetype,
        fileSize: req.file.size,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/support/tickets
router.get('/tickets', async (req, res, next) => {
  try {
    const data = await listSupportTickets(prisma, {
      status: req.query.status,
      priority: req.query.priority,
      requesterType: req.query.requesterType,
      assigned: req.query.assigned,
      search: req.query.search,
      actorId: req.adminActor?.actorId,
    });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/support/tickets/:ticketKey
router.get('/tickets/:ticketKey', async (req, res, next) => {
  try {
    res.json({ success: true, data: await getSupportTicket(prisma, req.params.ticketKey) });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/support/tickets/:ticketKey/claim
router.post('/tickets/:ticketKey/claim', async (req, res, next) => {
  try {
    res.json({ success: true, data: await assignTicket(prisma, req.params.ticketKey, req.adminActor) });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/support/tickets/:ticketKey/reply
router.post('/tickets/:ticketKey/reply', async (req, res, next) => {
  try {
    const data = await addAdminReply(prisma, req.params.ticketKey, req.body || {}, req.adminActor);
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/support/tickets/:ticketKey/status
router.post('/tickets/:ticketKey/status', async (req, res, next) => {
  try {
    res.json({
      success: true,
      data: await updateTicketStatus(prisma, req.params.ticketKey, req.body?.status, req.adminActor),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
