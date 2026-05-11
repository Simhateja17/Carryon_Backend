const { Router } = require('express');
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');

const router = Router();

const VALID_STATUSES = new Set([
  'PENDING', 'SEARCHING_DRIVER', 'DRIVER_ASSIGNED', 'DRIVER_ARRIVED',
  'PICKUP_DONE', 'IN_TRANSIT', 'ARRIVED_AT_DROP', 'DELIVERED', 'CANCELLED',
]);

const VALID_VEHICLE_TYPES = new Set([
  'BIKE', 'CAR', 'PICKUP', 'VAN_7FT', 'VAN_9FT',
  'LORRY_10FT', 'LORRY_14FT', 'LORRY_17FT',
]);

// GET /api/admin/bookings
router.get('/', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const skip = (page - 1) * limit;

    const { status, vehicleType, search, dateFrom, dateTo } = req.query;

    const where = {};

    if (status && status !== 'all') {
      const upperStatus = String(status).toUpperCase();
      if (!VALID_STATUSES.has(upperStatus)) {
        return next(new AppError('Invalid status filter', 400));
      }
      where.status = upperStatus;
    }

    if (vehicleType && vehicleType !== 'all') {
      const upperType = String(vehicleType).toUpperCase();
      if (!VALID_VEHICLE_TYPES.has(upperType)) {
        return next(new AppError('Invalid vehicleType filter', 400));
      }
      where.vehicleType = upperType;
    }

    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) {
        const from = new Date(dateFrom);
        if (isNaN(from.getTime())) return next(new AppError('Invalid dateFrom', 400));
        where.createdAt.gte = from;
      }
      if (dateTo) {
        const to = new Date(dateTo);
        if (isNaN(to.getTime())) return next(new AppError('Invalid dateTo', 400));
        where.createdAt.lte = to;
      }
    }

    if (search) {
      const term = String(search).trim().slice(0, 100);
      if (term.length > 0) {
        where.OR = [
          { orderCode: { contains: term, mode: 'insensitive' } },
          { user: { name: { contains: term, mode: 'insensitive' } } },
          { user: { email: { contains: term, mode: 'insensitive' } } },
          { deliveryAddress: { address: { contains: term, mode: 'insensitive' } } },
          { pickupAddress: { address: { contains: term, mode: 'insensitive' } } },
        ];
      }
    }

    const [total, bookings] = await Promise.all([
      prisma.booking.count({ where }),
      prisma.booking.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          orderCode: true,
          status: true,
          vehicleType: true,
          estimatedPrice: true,
          finalPrice: true,
          createdAt: true,
          updatedAt: true,
          user: {
            select: { id: true, name: true, email: true, phone: true },
          },
          driver: {
            select: { id: true, name: true, photo: true, phone: true },
          },
          pickupAddress: {
            select: { address: true, contactName: true },
          },
          deliveryAddress: {
            select: { address: true, contactName: true },
          },
        },
      }),
    ]);

    console.log(
      '[admin-bookings] GET / — page:', page,
      'limit:', limit,
      'total:', total,
      'filters:', { status, vehicleType, search: search ? '[redacted]' : undefined }
    );

    res.json({
      success: true,
      data: bookings,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
