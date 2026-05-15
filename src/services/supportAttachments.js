const MAX_ATTACHMENTS_PER_MESSAGE = 5;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
]);

function isAllowedSupportAttachment(file) {
  if (!file) return false;
  if (ALLOWED_MIME_TYPES.has(String(file.mimetype || '').toLowerCase())) return true;
  const ext = String(file.originalname || '').split('.').pop()?.toLowerCase();
  return ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'pdf'].includes(ext || '');
}

function normalizeAttachments(raw) {
  if (!raw) return [];
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, MAX_ATTACHMENTS_PER_MESSAGE)
    .map((item) => ({
      fileUrl: String(item.fileUrl || item.url || '').trim(),
      storagePath: String(item.storagePath || item.fileUrl || item.url || '').trim(),
      mimeType: String(item.mimeType || '').trim().toLowerCase(),
      fileSize: Number(item.fileSize || 0),
    }))
    .filter((item) => item.fileUrl && item.storagePath);
}

function validateAttachments(raw) {
  const attachments = normalizeAttachments(raw);
  if (Array.isArray(raw) && raw.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return { ok: false, message: `A message can include at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments` };
  }
  for (const attachment of attachments) {
    if (!ALLOWED_MIME_TYPES.has(attachment.mimeType)) {
      return { ok: false, message: 'Attachments must be images or PDFs' };
    }
    if (!Number.isFinite(attachment.fileSize) || attachment.fileSize <= 0 || attachment.fileSize > MAX_ATTACHMENT_BYTES) {
      return { ok: false, message: 'Each attachment must be 5MB or smaller' };
    }
  }
  return { ok: true, attachments };
}

function attachmentCreateMany({ attachments, ticketId, messageId, uploadedById, uploadedByType }) {
  return attachments.map((attachment) => ({
    ticketId,
    messageId,
    uploadedById,
    uploadedByType,
    fileUrl: attachment.fileUrl,
    storagePath: attachment.storagePath,
    mimeType: attachment.mimeType,
    fileSize: attachment.fileSize,
  }));
}

module.exports = {
  ALLOWED_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  attachmentCreateMany,
  isAllowedSupportAttachment,
  validateAttachments,
};
