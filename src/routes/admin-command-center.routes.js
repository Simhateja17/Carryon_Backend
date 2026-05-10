const { Router } = require('express');
const prisma = require('../lib/prisma');

const router = Router();

const ACTIVE_BOOKING_STATUSES = [
  'SEARCHING_DRIVER',
  'DRIVER_ASSIGNED',
  'DRIVER_ARRIVED',
  'PICKUP_DONE',
  'IN_TRANSIT',
  'ARRIVED_AT_DROP',
];

function startOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function percentageChange(current, previous) {
  if (!previous) return current ? 100 : 0;
  return ((current - previous) / previous) * 100;
}

function formatTrend(value) {
  const rounded = Math.abs(value).toFixed(1);
  return `${value >= 0 ? '+' : '-'}${rounded}%`;
}

function formatCurrency(value) {
  if (value >= 1000) return `RM ${(value / 1000).toFixed(1)}k`;
  return `RM ${value.toFixed(2)}`;
}

function minutesAgo(date) {
  if (!date) return '--';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function routeLabel(booking) {
  const pickup = booking.pickupAddress?.label || booking.pickupAddress?.address || 'Pickup';
  const drop = booking.deliveryAddress?.label || booking.deliveryAddress?.address || 'Drop';
  return `${pickup} -> ${drop}`;
}

router.get('/', async (_req, res, next) => {
  try {
    const now = new Date();
    const todayStart = startOfDay(now);
    const tomorrowStart = addDays(todayStart, 1);
    const yesterdayStart = addDays(todayStart, -1);
    const sevenDaysStart = addDays(todayStart, -6);

    const [
      todayOrders,
      yesterdayOrders,
      activeDeliveries,
      cancelledToday,
      cancelledYesterday,
      todayRevenueAgg,
      yesterdayRevenueAgg,
      onlineDrivers,
      deliveringBookings,
      recentBookings,
      weeklyBookings,
      notificationsLast24h,
      recentAuditLogs,
      pendingExtraCharges,
      activeDelayedBookings,
      orderBreakdown,
      liveDrivers,
    ] = await Promise.all([
      prisma.booking.count({ where: { createdAt: { gte: todayStart, lt: tomorrowStart } } }),
      prisma.booking.count({ where: { createdAt: { gte: yesterdayStart, lt: todayStart } } }),
      prisma.booking.count({ where: { status: { in: ACTIVE_BOOKING_STATUSES } } }),
      prisma.booking.count({ where: { status: 'CANCELLED', updatedAt: { gte: todayStart, lt: tomorrowStart } } }),
      prisma.booking.count({ where: { status: 'CANCELLED', updatedAt: { gte: yesterdayStart, lt: todayStart } } }),
      prisma.booking.aggregate({
        _sum: { finalPrice: true },
        where: { createdAt: { gte: todayStart, lt: tomorrowStart }, status: { not: 'CANCELLED' } },
      }),
      prisma.booking.aggregate({
        _sum: { finalPrice: true },
        where: { createdAt: { gte: yesterdayStart, lt: todayStart }, status: { not: 'CANCELLED' } },
      }),
      prisma.driver.count({ where: { isOnline: true } }),
      prisma.booking.count({ where: { status: { in: ['PICKUP_DONE', 'IN_TRANSIT', 'ARRIVED_AT_DROP'] } } }),
      prisma.booking.findMany({
        where: { status: { in: ACTIVE_BOOKING_STATUSES } },
        orderBy: { updatedAt: 'desc' },
        take: 5,
        include: {
          user: { select: { name: true, email: true } },
          driver: { select: { name: true } },
          pickupAddress: true,
          deliveryAddress: true,
        },
      }),
      prisma.booking.findMany({
        where: { createdAt: { gte: sevenDaysStart, lt: tomorrowStart } },
        select: { createdAt: true },
      }),
      prisma.driverNotification.count({ where: { createdAt: { gte: addDays(now, -1) } } }),
      prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 6 }),
      prisma.bookingExtraCharge.findMany({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
        take: 2,
        include: { driver: { select: { name: true } }, booking: { select: { orderCode: true } } },
      }),
      prisma.booking.findMany({
        where: {
          status: { in: ACTIVE_BOOKING_STATUSES },
          updatedAt: { lt: new Date(Date.now() - 60 * 60 * 1000) },
        },
        orderBy: { updatedAt: 'asc' },
        take: 2,
        include: { driver: { select: { name: true } } },
      }),
      prisma.booking.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.driver.findMany({
        where: { isOnline: true },
        orderBy: { createdAt: 'desc' },
        take: 6,
        select: { id: true, currentLatitude: true, currentLongitude: true, vehicle: { select: { type: true } } },
      }),
    ]);

    const todayRevenue = todayRevenueAgg._sum.finalPrice || 0;
    const yesterdayRevenue = yesterdayRevenueAgg._sum.finalPrice || 0;
    const stats = [
      {
        label: 'TOTAL ORDERS\n(TODAY)',
        value: String(todayOrders),
        trend: formatTrend(percentageChange(todayOrders, yesterdayOrders)),
        up: todayOrders >= yesterdayOrders,
      },
      {
        label: 'ACTIVE DELIVERIES',
        value: String(activeDeliveries),
        trend: `${onlineDrivers} online`,
        up: true,
      },
      {
        label: "TODAY'S REVENUE",
        value: formatCurrency(todayRevenue),
        trend: formatTrend(percentageChange(todayRevenue, yesterdayRevenue)),
        up: todayRevenue >= yesterdayRevenue,
      },
      {
        label: 'CANCELLED\nORDERS',
        value: String(cancelledToday),
        trend: formatTrend(percentageChange(cancelledToday, cancelledYesterday)),
        up: cancelledToday <= cancelledYesterday,
      },
    ];

    const weeklyOrders = Array.from({ length: 7 }, (_, index) => {
      const day = addDays(sevenDaysStart, index);
      const nextDay = addDays(day, 1);
      return {
        day: day.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
        count: weeklyBookings.filter((booking) => booking.createdAt >= day && booking.createdAt < nextDay).length,
      };
    });

    const breakdownTotal = orderBreakdown.reduce((sum, row) => sum + row._count._all, 0) || 1;
    const breakdown = orderBreakdown.map((row) => ({
      status: row.status,
      count: row._count._all,
      pct: Math.round((row._count._all / breakdownTotal) * 100),
    }));

    const alerts = [
      ...pendingExtraCharges.map((charge) => ({
        severity: 'critical',
        label: 'Extra Charge Review',
        title: `${charge.type} proof pending`,
        detail: `${charge.booking?.orderCode || charge.bookingId} - ${charge.driver?.name || 'Driver'} - ${minutesAgo(charge.createdAt)}`,
      })),
      ...activeDelayedBookings.map((booking) => ({
        severity: 'warning',
        label: 'Route Delay',
        title: `${booking.orderCode || booking.id} needs dispatch review`,
        detail: `${booking.driver?.name || 'Unassigned'} - ${minutesAgo(booking.updatedAt)}`,
      })),
    ].slice(0, 4);

    res.json({
      success: true,
      data: {
        stats,
        weeklyOrders,
        breakdown,
        fleet: {
          inTransit: activeDeliveries,
          delivering: deliveringBookings,
          idle: Math.max(onlineDrivers - deliveringBookings, 0),
          pins: liveDrivers.map((driver, index) => ({
            id: driver.id,
            vehicleType: driver.vehicle?.type || 'CAR',
            top: 30 + (index % 3) * 12,
            left: 28 + (index % 4) * 12,
          })),
        },
        alerts,
        recentOrders: recentBookings.map((booking) => ({
          id: booking.orderCode || booking.id,
          customer: booking.user?.name || booking.user?.email || 'Customer',
          route: routeLabel(booking),
          driver: booking.driver?.name || 'Unassigned',
          status: booking.status,
          etd: booking.eta ? `${booking.eta} mins` : minutesAgo(booking.updatedAt),
        })),
        systemLogs: recentAuditLogs.map((log) => ({
          title: log.action.replace(/_/g, ' '),
          desc: `${log.entityType} ${log.entityId} - ${minutesAgo(log.createdAt)}`,
          badge: log.actorType,
        })),
        notificationHealth: {
          deliveredLast24h: notificationsLast24h,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
