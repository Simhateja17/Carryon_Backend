const prisma = require('../lib/prisma');
const { uploadToSupabase } = require('../lib/supabase');
const { validateImageMagicBytes } = require('../lib/imageValidation');
const { AppError } = require('../middleware/errorHandler');

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

const VALID_DRIVER_DOCUMENT_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

function assertValidDocumentType(type) {
  if (!type) throw new AppError('Document type is required', 400);
  if (!VALID_DOCUMENT_TYPES.has(type)) throw new AppError('Invalid document type', 400);
}

function fileLooksLikeSupportedDriverDocument(file) {
  if (!file) return false;
  if (VALID_DRIVER_DOCUMENT_IMAGE_TYPES.has(file.mimetype)) return true;

  const ext = String(file.originalname || '').split('.').pop()?.toLowerCase();
  return ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'].includes(ext);
}

function sanitizeStorageError(error) {
  return {
    name: error?.name || 'Error',
    statusCode: error?.statusCode || error?.status || null,
    code: error?.code || null,
    message: error?.statusCode === 403 || error?.status === 403
      ? 'Storage upload was rejected by Supabase'
      : 'Storage upload failed',
  };
}

async function uploadDriverDocument({
  driverId,
  file,
  type,
  expiryDate = null,
  upload = uploadToSupabase,
  documents = prisma.driverDocument,
  now = Date.now,
}) {
  if (!driverId) throw new AppError('Driver profile not found. Please register first.', 401);
  if (!file) throw new AppError('No image file provided', 400);
  assertValidDocumentType(type);

  const detected = validateImageMagicBytes(file);
  if (!detected) throw new AppError('File is not a valid image', 400);

  const fileName = `${driverId}/${type}_${now()}.${detected.ext}`;
  const storageFile = { ...file, mimetype: detected.type };
  let imageUrl;
  try {
    imageUrl = await upload('driver-documents', storageFile, fileName, { upsert: true });
  } catch (error) {
    console.error('[driver-documents] storage upload failed', JSON.stringify({
      driverId,
      type,
      detectedType: detected.type,
      bucket: 'driver-documents',
      pathPrefix: `${driverId}/`,
      storage: sanitizeStorageError(error),
    }));
    throw new AppError('Failed to upload document', 500);
  }

  return documents.upsert({
    where: { driverId_type: { driverId, type } },
    update: {
      imageUrl,
      expiryDate,
      status: 'PENDING',
      rejectionReason: null,
    },
    create: {
      driverId,
      type,
      imageUrl,
      expiryDate,
    },
  });
}

module.exports = {
  VALID_DOCUMENT_TYPES,
  VALID_DRIVER_DOCUMENT_IMAGE_TYPES,
  assertValidDocumentType,
  fileLooksLikeSupportedDriverDocument,
  uploadDriverDocument,
};
