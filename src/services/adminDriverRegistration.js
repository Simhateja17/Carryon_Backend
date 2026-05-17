const { z } = require('zod');
const { Prisma } = require('@prisma/client');
const { AppError } = require('../middleware/errorHandler');
const { recordAudit } = require('./auditLog');
const { MALAYSIAN_DRIVER_NATIONALITY } = require('../lib/driverOnboardingRequirements');
const { VALID_DOCUMENT_TYPES } = require('./driverDocumentUpload');
const { VALID_VEHICLE_TYPES, normalizeVehicleType } = require('./businessConfig');

const MAX_TEXT = 160;
const MAX_LONG_TEXT = 320;
const DOCUMENT_TYPES = Array.from(VALID_DOCUMENT_TYPES);

const AdminDriverRegistrationSchema = z.object({
  name: z.string().trim().min(1).max(MAX_TEXT),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  phone: z.string().trim().min(3).max(40),
  dateOfBirth: z.string().trim().max(40).optional().default(''),
  governmentId: z.string().trim().max(80).optional().default(''),
  addressLine1: z.string().trim().max(MAX_LONG_TEXT).optional().default(''),
  addressLine2: z.string().trim().max(MAX_LONG_TEXT).optional().default(''),
  city: z.string().trim().max(80).optional().default(''),
  postcode: z.string().trim().max(20).optional().default(''),
  state: z.string().trim().max(80).optional().default(''),
  driversLicenseNumber: z.string().trim().max(80).optional().default(''),
  licenseClass: z.string().trim().max(40).optional().default(''),
  licenseExpiry: z.string().trim().max(40).optional().default(''),
  emergencyContactName: z.string().trim().max(MAX_TEXT).optional().default(''),
  emergencyContactRelation: z.string().trim().max(80).optional().default(''),
  emergencyContactPhone: z.string().trim().max(40).optional().default(''),
  pdpaConsent: z.boolean().optional().default(false),
  backgroundCheckConsent: z.boolean().optional().default(false),
  noOffencesDeclared: z.boolean().optional().default(false),
  vehicle: z.object({
    type: z.string().trim().min(1).max(40),
    make: z.string().trim().max(80).optional().default(''),
    model: z.string().trim().max(80).optional().default(''),
    year: z.number().int().min(1980).max(2100),
    licensePlate: z.string().trim().max(40).optional().default(''),
    color: z.string().trim().max(40).optional().default(''),
    chassisNumber: z.string().trim().max(80).optional().default(''),
    engineNumber: z.string().trim().max(80).optional().default(''),
    ownership: z.string().trim().max(40).optional().default(''),
    ownerName: z.string().trim().max(MAX_TEXT).optional().default(''),
    roadTaxExpiry: z.string().trim().max(40).optional().default(''),
    insurerName: z.string().trim().max(MAX_TEXT).optional().default(''),
    insurancePolicyNumber: z.string().trim().max(120).optional().default(''),
    insuranceExpiry: z.string().trim().max(40).optional().default(''),
    hasCommercialCover: z.boolean().optional().default(false),
  }).strict().optional(),
  documents: z.array(z.object({
    type: z.enum(DOCUMENT_TYPES),
    imageUrl: z.string().trim().min(1).max(500).refine((value) => !value.startsWith('http'), {
      message: 'Use a storage object path, not a public URL',
    }),
    expiryDate: z.string().trim().max(40).optional().default(''),
  }).strict()).max(32).optional().default([]),
}).strict();

function parseAdminDriverRegistration(body) {
  const result = AdminDriverRegistrationSchema.safeParse(body);
  if (!result.success) {
    const err = new AppError('Invalid driver registration', 422);
    err.details = result.error.flatten();
    throw err;
  }
  const vehicleType = result.data.vehicle ? normalizeVehicleType(result.data.vehicle.type) : null;
  if (result.data.vehicle && (!vehicleType || !VALID_VEHICLE_TYPES.includes(vehicleType))) {
    throw new AppError('Invalid vehicle type', 400);
  }

  const seenDocumentTypes = new Set();
  for (const document of result.data.documents) {
    if (seenDocumentTypes.has(document.type)) {
      throw new AppError(`Duplicate document type: ${document.type}`, 400);
    }
    seenDocumentTypes.add(document.type);
  }

  return {
    ...result.data,
    vehicle: result.data.vehicle ? { ...result.data.vehicle, type: vehicleType } : undefined,
  };
}

async function createAdminDriverRegistration({ db, body, actor }) {
  const input = parseAdminDriverRegistration(body);

  try {
    return await db.$transaction(async (tx) => {
      const driver = await tx.driver.create({
        data: {
          name: input.name,
          email: input.email,
          phone: input.phone,
          dateOfBirth: input.dateOfBirth,
          nationality: MALAYSIAN_DRIVER_NATIONALITY,
          mykadNumber: input.governmentId,
          addressLine1: input.addressLine1,
          addressLine2: input.addressLine2,
          city: input.city,
          postcode: input.postcode,
          state: input.state,
          driversLicenseNumber: input.driversLicenseNumber,
          licenseClass: input.licenseClass,
          licenseExpiry: input.licenseExpiry || null,
          emergencyContact: input.emergencyContactPhone || input.emergencyContactName || '',
          emergencyContactName: input.emergencyContactName,
          emergencyContactRelation: input.emergencyContactRelation,
          emergencyContactPhone: input.emergencyContactPhone,
          pdpaConsent: input.pdpaConsent,
          backgroundCheckConsent: input.backgroundCheckConsent,
          noOffencesDeclared: input.noOffencesDeclared,
          verificationStatus: 'PENDING',
          isVerified: false,
        },
        include: {
          documents: { select: { id: true, type: true, status: true } },
          vehicle: { select: { id: true, type: true, make: true, model: true } },
          pushDevices: {
            where: { notificationsEnabled: true },
            select: { id: true },
            take: 1,
          },
        },
      });

      await tx.driverWallet.create({ data: { driverId: driver.id } });

      if (input.vehicle) {
        await tx.driverVehicle.create({
          data: {
            driverId: driver.id,
            type: input.vehicle.type,
            make: input.vehicle.make,
            model: input.vehicle.model,
            year: input.vehicle.year,
            licensePlate: input.vehicle.licensePlate,
            color: input.vehicle.color,
            chassisNumber: input.vehicle.chassisNumber,
            engineNumber: input.vehicle.engineNumber,
            ownership: input.vehicle.ownership,
            ownerName: input.vehicle.ownerName,
            roadTaxExpiry: input.vehicle.roadTaxExpiry || null,
            insurerName: input.vehicle.insurerName,
            insurancePolicyNumber: input.vehicle.insurancePolicyNumber,
            insuranceExpiry: input.vehicle.insuranceExpiry || null,
            hasCommercialCover: input.vehicle.hasCommercialCover,
          },
        });
      }

      for (const document of input.documents) {
        await tx.driverDocument.create({
          data: {
            driverId: driver.id,
            type: document.type,
            imageUrl: document.imageUrl,
            expiryDate: document.expiryDate || null,
            status: 'PENDING',
          },
        });
      }

      await recordAudit(tx, {
        actor,
        action: 'ADMIN_DRIVER_REGISTERED',
        entityType: 'Driver',
        entityId: driver.id,
        newValue: {
          email: input.email,
          phone: input.phone,
          verificationStatus: 'PENDING',
          hasVehicle: !!input.vehicle,
          documentCount: input.documents.length,
        },
      });

      return tx.driver.findUnique({
        where: { id: driver.id },
        include: {
          documents: { select: { id: true, type: true, status: true } },
          vehicle: { select: { id: true, type: true, make: true, model: true } },
          pushDevices: {
            where: { notificationsEnabled: true },
            select: { id: true },
            take: 1,
          },
        },
      });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError('A driver with this email already exists', 409);
    }
    throw err;
  }
}

module.exports = {
  AdminDriverRegistrationSchema,
  createAdminDriverRegistration,
  parseAdminDriverRegistration,
};
