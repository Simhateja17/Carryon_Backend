const { Router } = require('express');
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { recordAudit } = require('../services/auditLog');
const {
  DRIVER_COMMISSION_RATE,
  VEHICLE_CATALOG,
  VALID_VEHICLE_TYPES,
  defaultVehiclePricing,
  normalizeVehicleType,
  vehicleLabel,
} = require('../services/businessConfig');

const router = Router();

function sanitizeVehicle(input) {
  const type = normalizeVehicleType(input.type || input.iconName || input.name);
  if (!type) throw new AppError('Invalid vehicle type', 400);
  const name = String(input.name || '').trim();
  const basePrice = Number(input.basePrice);
  const pricePerKm = Number(input.pricePerKm);
  const minimumFare = Number(input.minimumFare ?? input.basePrice);

  if (!name || name.length > 80) throw new AppError('Vehicle name is required', 400);
  if (!Number.isFinite(basePrice) || basePrice < 0 || basePrice > 100000) {
    throw new AppError('basePrice must be a valid positive number', 400);
  }
  if (!Number.isFinite(pricePerKm) || pricePerKm < 0 || pricePerKm > 10000) {
    throw new AppError('pricePerKm must be a valid positive number', 400);
  }
  if (!Number.isFinite(minimumFare) || minimumFare < 0 || minimumFare > 100000) {
    throw new AppError('minimumFare must be a valid positive number', 400);
  }

  return {
    id: input.id ? String(input.id) : null,
    type,
    name,
    basePrice,
    pricePerKm,
    minimumFare,
    isAvailable: input.isAvailable !== false,
  };
}

function vehicleRowType(vehicle) {
  return normalizeVehicleType(vehicle.iconName || vehicle.name);
}

function projectPricingRows(vehicles) {
  const byType = new Map();
  for (const vehicle of vehicles) {
    const type = vehicleRowType(vehicle);
    if (!type || byType.has(type)) continue;
    const catalogEntry = VEHICLE_CATALOG.find((entry) => entry.type === type);
    byType.set(type, {
      id: vehicle.id,
      type,
      name: vehicle.name || vehicleLabel(type),
      basePrice: vehicle.basePrice,
      pricePerKm: vehicle.pricePerKm,
      minimumFare: catalogEntry?.defaultMinimumFare ?? vehicle.basePrice,
      isAvailable: vehicle.isAvailable,
    });
  }

  return VALID_VEHICLE_TYPES.map((type) => byType.get(type) || defaultVehiclePricing(type));
}

function minutesAgo(date) {
  if (!date) return '--';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

router.get('/', async (_req, res, next) => {
  try {
    const [vehicles, coupons, history] = await Promise.all([
      prisma.vehicle.findMany({ orderBy: { name: 'asc' } }),
      prisma.coupon.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
      prisma.auditLog.findMany({
        where: { action: { in: ['ADMIN_PRICING_UPDATED'] } },
        orderBy: { createdAt: 'desc' },
        take: 6,
      }),
    ]);

    const vehicleRows = projectPricingRows(vehicles);

    res.json({
      success: true,
      data: {
        vehicles: vehicleRows,
        commissionRate: DRIVER_COMMISSION_RATE,
        coupons: coupons.map((coupon) => ({
          id: coupon.id,
          code: coupon.code,
          desc: coupon.description || `${coupon.discountValue}${coupon.discountType === 'PERCENTAGE' ? '%' : ' RM'} off`,
          status: coupon.isActive ? 'ACTIVE' : 'PAUSED',
          expires: coupon.expiresAt ? coupon.expiresAt.toISOString() : 'N/A',
          usage: `${coupon.usedCount} / ${coupon.usageLimit}`,
        })),
        history: history.map((item) => ({
          time: minutesAgo(item.createdAt),
          user: item.actorId,
          action: item.action.replace(/_/g, ' '),
          status: 'SUCCESS',
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.put('/vehicles', async (req, res, next) => {
  try {
    if (!Array.isArray(req.body?.vehicles)) {
      return next(new AppError('vehicles must be an array', 400));
    }

    const vehicles = req.body.vehicles.map(sanitizeVehicle);
    if (vehicles.length > 20) {
      return next(new AppError('Cannot update more than 20 vehicle pricing rows at once', 400));
    }

    const previous = await prisma.vehicle.findMany({ orderBy: { name: 'asc' } });
    const updated = await prisma.$transaction(async (tx) => {
      const rows = [];
      for (const vehicle of vehicles) {
        if (vehicle.id) {
          rows.push(await tx.vehicle.update({
            where: { id: vehicle.id },
            data: {
              name: vehicle.name,
              basePrice: vehicle.basePrice,
              pricePerKm: vehicle.pricePerKm,
              iconName: vehicle.type,
              isAvailable: vehicle.isAvailable,
            },
          }));
        } else {
          rows.push(await tx.vehicle.create({
            data: {
              name: vehicle.name,
              description: 'Admin configured vehicle fare',
              capacity: '',
              basePrice: vehicle.basePrice,
              pricePerKm: vehicle.pricePerKm,
              iconName: vehicle.type,
              isAvailable: vehicle.isAvailable,
            },
          }));
        }
      }
      await recordAudit(tx, {
        actor: req.adminActor,
        action: 'ADMIN_PRICING_UPDATED',
        entityType: 'Vehicle',
        entityId: 'pricing',
        oldValue: previous,
        newValue: rows,
      });
      return rows;
    });

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
