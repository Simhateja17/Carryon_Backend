const { Router } = require('express');
const prisma = require('../lib/prisma');

const router = Router();

const ACTIVE_STATUSES = [
  'PENDING',
  'SEARCHING_DRIVER',
  'DRIVER_ASSIGNED',
  'DRIVER_ARRIVED',
  'PICKUP_DONE',
  'IN_TRANSIT',
  'ARRIVED_AT_DROP',
];

const PAGE_LIMIT_MAX = 100;

// GET /api/admin/customers/stats — aggregate header-card data
router.get('/stats', async (req, res, next) => {
  try {
    console.log('[admin-customers] GET /customers/stats');

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [totalUsers, verifiedUsers, activeUsers, revenueResult] = await Promise.all([
      prisma.user.count({ where: { deletedAt: null } }),
      prisma.user.count({ where: { deletedAt: null, isVerified: true } }),
      prisma.user.count({
        where: {
          deletedAt: null,
          bookings: { some: { createdAt: { gte: thirtyDaysAgo } } },
        },
      }),
      prisma.booking.aggregate({
        _sum: { finalPrice: true },
        where: { paymentStatus: 'COMPLETED' },
      }),
    ]);

    console.log('[admin-customers] stats — totalUsers:', totalUsers, 'activeUsers:', activeUsers);

    res.json({
      success: true,
      data: {
        totalUsers,
        verifiedUsers,
        activeUsers,
        totalRevenue: revenueResult._sum.finalPrice ?? 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/customers?page=1&limit=20&search=
router.get('/', async (req, res, next) => {
  try {
    const rawPage = parseInt(req.query.page, 10);
    const rawLimit = parseInt(req.query.limit, 10);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, PAGE_LIMIT_MAX)
      : 20;
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

    console.log('[admin-customers] GET /customers — page:', page, 'limit:', limit, 'search:', search || '(none)');

    const where = {
      deletedAt: null,
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search } },
            ],
          }
        : {}),
    };

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          isVerified: true,
          createdAt: true,
          _count: { select: { bookings: true } },
          bookings: {
            where: { status: { in: ACTIVE_STATUSES } },
            select: { id: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    // Fetch total spent per user in a single query (groupBy)
    const userIds = users.map((u) => u.id);
    const spentRows = await prisma.booking.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds }, paymentStatus: 'COMPLETED' },
      _sum: { finalPrice: true },
    });
    const spentMap = Object.fromEntries(
      spentRows.map((r) => [r.userId, r._sum.finalPrice ?? 0])
    );

    // Fetch last order date per user
    const lastOrderRows = await prisma.booking.findMany({
      where: { userId: { in: userIds } },
      orderBy: { createdAt: 'desc' },
      distinct: ['userId'],
      select: { userId: true, createdAt: true },
    });
    const lastOrderMap = Object.fromEntries(
      lastOrderRows.map((r) => [r.userId, r.createdAt])
    );

    const customers = users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      isVerified: u.isVerified,
      totalOrders: u._count.bookings,
      activeOrders: u.bookings.length,
      totalSpent: spentMap[u.id] ?? 0,
      createdAt: u.createdAt,
      lastOrderAt: lastOrderMap[u.id] ?? null,
    }));

    console.log('[admin-customers] GET /customers — returned', customers.length, 'of', total, 'users');

    res.json({
      success: true,
      data: { customers, total, totalPages: Math.ceil(total / limit), page, limit },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
