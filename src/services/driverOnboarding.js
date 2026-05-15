const { z } = require('zod');
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { recordAudit } = require('./auditLog');
const { VALID_DOCUMENT_TYPES } = require('./driverDocumentUpload');
const { normalizeVehicleType } = require('./businessConfig');
const { isDriverDocumentPathForDriver } = require('../lib/driverDocumentPaths');
const {
  MALAYSIAN_DRIVER_NATIONALITY,
  missingDocumentTypes,
} = require('../lib/driverOnboardingRequirements');

const MAX_TEXT = 160;
const MAX_LONG_TEXT = 320;

function optionalTrimmed(max = MAX_TEXT) {
  return z.string().trim().max(max).optional().nullable().transform((value) => value || '');
}

function nullableTrimmed(max = MAX_TEXT) {
  return z.string().trim().max(max).optional().nullable().transform((value) => value || null);
}

const profileSchema = z.object({
  name: z.string().trim().min(1).max(MAX_TEXT),
  phone: optionalTrimmed(40),
  photo: optionalTrimmed(MAX_LONG_TEXT),
  dateOfBirth: nullableTrimmed(40),
  gender: optionalTrimmed(40),
  language: optionalTrimmed(16),
  nationality: optionalTrimmed(40),
  mykadNumber: optionalTrimmed(40),
  passportNumber: optionalTrimmed(80),
  passportExpiry: nullableTrimmed(40),
  plksNumber: optionalTrimmed(80),
  plksExpiry: nullableTrimmed(40),
  driversLicenseNumber: optionalTrimmed(80),
  licenseClass: optionalTrimmed(40),
  licenseExpiry: nullableTrimmed(40),
  hasGDL: z.boolean().optional().default(false),
  gdlExpiry: nullableTrimmed(40),
  addressLine1: optionalTrimmed(MAX_LONG_TEXT),
  addressLine2: optionalTrimmed(MAX_LONG_TEXT),
  city: optionalTrimmed(80),
  postcode: optionalTrimmed(20),
  state: optionalTrimmed(80),
  workingStates: z.array(z.string().trim().min(1).max(80)).max(20).optional().default([]),
  emergencyContactName: optionalTrimmed(MAX_TEXT),
  emergencyContactRelation: optionalTrimmed(80),
  emergencyContactPhone: optionalTrimmed(40),
  bankName: optionalTrimmed(120),
  bankAccountNumber: optionalTrimmed(80),
  bankAccountHolder: optionalTrimmed(MAX_TEXT),
  duitNowId: optionalTrimmed(120),
  tngEwalletId: optionalTrimmed(120),
  lhdnTaxNumber: optionalTrimmed(80),
  sstNumber: optionalTrimmed(80),
  pdpaConsent: z.boolean(),
  backgroundCheckConsent: z.boolean(),
  noOffencesDeclared: z.boolean(),
  agreementVersion: optionalTrimmed(80),
}).strict();

const vehicleSchema = z.object({
  type: z.string().trim().min(1).max(40),
  make: optionalTrimmed(80),
  model: optionalTrimmed(80),
  year: z.number().int().min(1980).max(2100),
  licensePlate: optionalTrimmed(40),
  color: optionalTrimmed(40),
  chassisNumber: optionalTrimmed(80),
  engineNumber: optionalTrimmed(80),
  ownership: optionalTrimmed(40),
  ownerName: optionalTrimmed(MAX_TEXT),
  roadTaxExpiry: nullableTrimmed(40),
  puspakomExpiry: nullableTrimmed(40),
  apadPermitNumber: optionalTrimmed(80),
  apadPermitExpiry: nullableTrimmed(40),
  insurerName: optionalTrimmed(MAX_TEXT),
  insurancePolicyNumber: optionalTrimmed(120),
  insuranceCoverageType: optionalTrimmed(80),
  insuranceExpiry: nullableTrimmed(40),
  hasCommercialCover: z.boolean().optional().default(false),
}).strict();

const documentSchema = z.object({
  type: z.string().trim().min(1).max(80),
  imageUrl: z.string().trim().min(1).max(500),
  expiryDate: nullableTrimmed(40),
}).strict();

const onboardingSchema = z.object({
  profile: profileSchema,
  vehicle: vehicleSchema,
  documents: z.array(documentSchema).max(32).default([]),
  agreementAccepted: z.literal(true),
  agreementVersion: z.string().trim().min(1).max(80),
}).strict();

function parseOnboardingSubmission(body) {
  const result = onboardingSchema.safeParse(body);
  if (!result.success) {
    const err = new AppError('Invalid onboarding submission', 422);
    err.details = result.error.flatten();
    throw err;
  }

  const vehicleType = normalizeVehicleType(result.data.vehicle.type);
  if (!vehicleType) {
    throw new AppError('Invalid vehicle type', 400);
  }
  if (result.data.profile.nationality !== MALAYSIAN_DRIVER_NATIONALITY) {
    throw new AppError('Carry On currently accepts Malaysian drivers only', 400);
  }

  const seen = new Set();
  for (const document of result.data.documents) {
    if (!VALID_DOCUMENT_TYPES.has(document.type)) {
      throw new AppError(`Invalid document type: ${document.type}`, 400);
    }
    if (seen.has(document.type)) {
      throw new AppError(`Duplicate document type: ${document.type}`, 400);
    }
    seen.add(document.type);
  }
  const missingRequiredTypes = missingDocumentTypes(result.data.documents);
  if (missingRequiredTypes.length > 0) {
    throw new AppError(`Missing required driver documents: ${missingRequiredTypes.join(', ')}`, 400);
  }

  return {
    ...result.data,
    vehicle: { ...result.data.vehicle, type: vehicleType },
  };
}

function assertDocumentPathsBelongToDriver(documents, driverId) {
  for (const document of documents) {
    if (document.imageUrl.startsWith('http')) {
      throw new AppError('Public document URLs are not accepted. Submit storage object paths only.', 400);
    }
    if (!isDriverDocumentPathForDriver(document.imageUrl, driverId)) {
      throw new AppError('Document path must belong to your driver storage', 403);
    }
  }
}

function profileData(profile, submittedAt, agreementVersion, previous = {}) {
  const emergencyContact = profile.emergencyContactPhone || profile.emergencyContactName || '';
  return {
    name: profile.name,
    phone: profile.phone,
    photo: profile.photo || null,
    dateOfBirth: profile.dateOfBirth || '',
    gender: profile.gender,
    language: profile.language,
    nationality: profile.nationality,
    mykadNumber: profile.mykadNumber,
    passportNumber: profile.passportNumber,
    passportExpiry: profile.passportExpiry,
    plksNumber: profile.plksNumber,
    plksExpiry: profile.plksExpiry,
    driversLicenseNumber: profile.driversLicenseNumber,
    licenseClass: profile.licenseClass,
    licenseExpiry: profile.licenseExpiry,
    hasGDL: profile.hasGDL,
    gdlExpiry: profile.gdlExpiry,
    addressLine1: profile.addressLine1,
    addressLine2: profile.addressLine2,
    city: profile.city,
    postcode: profile.postcode,
    state: profile.state,
    workingStates: profile.workingStates,
    emergencyContact,
    emergencyContactName: profile.emergencyContactName,
    emergencyContactRelation: profile.emergencyContactRelation,
    emergencyContactPhone: profile.emergencyContactPhone,
    bankName: profile.bankName,
    bankAccountNumber: profile.bankAccountNumber,
    bankAccountHolder: profile.bankAccountHolder,
    duitNowId: profile.duitNowId,
    tngEwalletId: profile.tngEwalletId,
    lhdnTaxNumber: profile.lhdnTaxNumber,
    sstNumber: profile.sstNumber,
    pdpaConsent: profile.pdpaConsent,
    backgroundCheckConsent: profile.backgroundCheckConsent,
    noOffencesDeclared: profile.noOffencesDeclared,
    agreementVersion,
    verificationStatus: previous.verificationStatus === 'APPROVED' ? 'APPROVED' : 'IN_REVIEW',
    isVerified: previous.verificationStatus === 'APPROVED',
    onboardingSubmittedAt: submittedAt,
  };
}

function vehicleData(vehicle) {
  return {
    type: vehicle.type,
    make: vehicle.make,
    model: vehicle.model,
    year: vehicle.year,
    licensePlate: vehicle.licensePlate,
    color: vehicle.color,
    chassisNumber: vehicle.chassisNumber,
    engineNumber: vehicle.engineNumber,
    ownership: vehicle.ownership,
    ownerName: vehicle.ownerName,
    roadTaxExpiry: vehicle.roadTaxExpiry,
    puspakomExpiry: vehicle.puspakomExpiry,
    apadPermitNumber: vehicle.apadPermitNumber,
    apadPermitExpiry: vehicle.apadPermitExpiry,
    insurerName: vehicle.insurerName,
    insurancePolicyNumber: vehicle.insurancePolicyNumber,
    insuranceCoverageType: vehicle.insuranceCoverageType,
    insuranceExpiry: vehicle.insuranceExpiry,
    hasCommercialCover: vehicle.hasCommercialCover,
  };
}

async function submitDriverOnboarding(driverId, body, { db = prisma, actor } = {}) {
  const submission = parseOnboardingSubmission(body);
  assertDocumentPathsBelongToDriver(submission.documents, driverId);
  const submittedAt = new Date();
  const agreementVersion = submission.agreementVersion || submission.profile.agreementVersion;

  return db.$transaction(async (tx) => {
    const before = await tx.driver.findUnique({
      where: { id: driverId },
      select: { id: true, verificationStatus: true, isVerified: true },
    });
    if (!before) throw new AppError('Driver not found', 404);

    await tx.driver.update({
      where: { id: driverId },
      data: profileData(submission.profile, submittedAt, agreementVersion, before),
    });

    await tx.driverVehicle.upsert({
      where: { driverId },
      update: vehicleData(submission.vehicle),
      create: { driverId, ...vehicleData(submission.vehicle) },
    });

    for (const document of submission.documents) {
      await tx.driverDocument.upsert({
        where: { driverId_type: { driverId, type: document.type } },
        update: {
          imageUrl: document.imageUrl,
          expiryDate: document.expiryDate,
          status: 'PENDING',
          rejectionReason: null,
        },
        create: {
          driverId,
          type: document.type,
          imageUrl: document.imageUrl,
          expiryDate: document.expiryDate,
        },
      });
    }

    const snapshot = await tx.driverOnboardingSubmission.create({
      data: {
        driverId,
        payload: submission,
        agreementVersion,
        submittedAt,
      },
    });

    await recordAudit(tx, {
      actor: actor || { actorId: driverId, actorType: 'DRIVER' },
      action: 'DRIVER_ONBOARDING_SUBMITTED',
      entityType: 'Driver',
      entityId: driverId,
      oldValue: before,
      newValue: {
        verificationStatus: before.verificationStatus === 'APPROVED' ? 'APPROVED' : 'IN_REVIEW',
        documentCount: submission.documents.length,
        submissionId: snapshot.id,
      },
    });

    return tx.driver.findUnique({
      where: { id: driverId },
      include: {
        documents: { orderBy: { uploadedAt: 'desc' } },
        vehicle: true,
      },
    });
  });
}

module.exports = {
  onboardingSchema,
  parseOnboardingSubmission,
  submitDriverOnboarding,
};
