const { z } = require('zod');
const { Prisma } = require('@prisma/client');
const { AppError } = require('../middleware/errorHandler');
const { recordAudit } = require('./auditLog');
const { MALAYSIAN_DRIVER_NATIONALITY } = require('../lib/driverOnboardingRequirements');

const MAX_TEXT = 160;
const MAX_LONG_TEXT = 320;

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
}).strict();

function parseAdminDriverRegistration(body) {
  const result = AdminDriverRegistrationSchema.safeParse(body);
  if (!result.success) {
    const err = new AppError('Invalid driver registration', 422);
    err.details = result.error.flatten();
    throw err;
  }
  return result.data;
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

      await recordAudit(tx, {
        actor,
        action: 'ADMIN_DRIVER_REGISTERED',
        entityType: 'Driver',
        entityId: driver.id,
        newValue: {
          email: input.email,
          phone: input.phone,
          verificationStatus: 'PENDING',
        },
      });

      return driver;
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
