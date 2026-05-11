const prisma = require('../lib/prisma');

const DASHBOARD_TIMEZONE = 'Asia/Kuala_Lumpur';
const TIMEZONE_OFFSET_MINUTES = 8 * 60;
const ACTIVE_BOOKING_STATUSES = [
  'PENDING',
  'SEARCHING_DRIVER',
  'DRIVER_ASSIGNED',
  'DRIVER_ARRIVED',
  'PICKUP_DONE',
  'IN_TRANSIT',
  'ARRIVED_AT_DROP',
];
const ACTIVE_DELIVERY_STATUSES = ACTIVE_BOOKING_STATUSES.filter((status) => status !== 'PENDING');
const HEATMAP_ROWS = ['Mon-Tue', 'Wed-Thu', 'Fri-Sat', 'Sun'];
const HEATMAP_COLUMNS = ['00-04', '04-08', '08-12', '12-16', '16-20', '20-24'];

function startOfDayInDashboardTimezone(date) {
  const shifted = new Date(date.getTime() + TIMEZONE_OFFSET_MINUTES * 60 * 1000);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - TIMEZONE_OFFSET_MINUTES * 60 * 1000);
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function dashboardDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: DASHBOARD_TIMEZONE,
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return {
    weekday: parts.find((part) => part.type === 'weekday')?.value || 'Mon',
    hour: Number(parts.find((part) => part.type === 'hour')?.value || 0),
  };
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

function minutesAgo(date, now = new Date()) {
  if (!date) return '--';
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(date).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function maskName(value, fallback) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  if (text.includes('@')) {
    const [local, domain] = text.split('@');
    return `${local.slice(0, 2)}***@${domain || 'email'}`;
  }
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].length > 12 ? `${parts[0].slice(0, 12)}...` : parts[0];
  return `${parts[0]} ${parts[1][0]}.`;
}

function compactAddress(address, fallback) {
  const text = String(address?.label || address?.address || fallback || '').trim();
  if (!text) return fallback;
  const withoutLongNumbers = text.replace(/\b\d{4,}\b/g, '...');
  return withoutLongNumbers.length > 34 ? `${withoutLongNumbers.slice(0, 31)}...` : withoutLongNumbers;
}

function routeLabel(booking) {
  return `${compactAddress(booking.pickupAddress, 'Pickup')} -> ${compactAddress(booking.deliveryAddress, 'Drop')}`;
}

function rowIndexForWeekday(weekday) {
  if (weekday === 'Mon' || weekday === 'Tue') return 0;
  if (weekday === 'Wed' || weekday === 'Thu') return 1;
  if (weekday === 'Fri' || weekday === 'Sat') return 2;
  return 3;
}

function buildDemandHeatmap(bookings) {
  const counts = HEATMAP_ROWS.map(() => HEATMAP_COLUMNS.map(() => 0));
  for (const booking of bookings) {
    const { weekday, hour } = dashboardDateParts(booking.createdAt);
    counts[rowIndexForWeekday(weekday)][Math.min(5, Math.floor(hour / 4))] += 1;
  }

  const max = Math.max(...counts.flat(), 1);
  return {
    rows: HEATMAP_ROWS,
    columns: HEATMAP_COLUMNS,
    max,
    cells: counts.map((row) => row.map((count) => ({ count, intensity: count / max }))),
  };
}

async function getCommandCenterSnapshot({ now = new Date() } = {}) {
  const todayStart = startOfDayInDashboardTimezone(now);
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
    heatmapBookings,
    notificationsLast24h,
    recentAuditLogs,
    pendingExtraCharges,
    activeDelayedBookings,
    orderBreakdown,
    liveDrivers,
  ] = await Promise.all([
    prisma.booking.count({ where: { createdAt: { gte: todayStart, lt: tomorrowStart } } }),
    prisma.booking.count({ where: { createdAt: { gte: yesterdayStart, lt: todayStart } } }),
    prisma.booking.count({ where: { status: { in: ACTIVE_DELIVERY_STATUSES } } }),
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
    prisma.booking.findMany({
      where: { createdAt: { gte: sevenDaysStart, lt: tomorrowStart } },
      select: { createdAt: true },
      take: 1000,
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
        updatedAt: { lt: new Date(now.getTime() - 60 * 60 * 1000) },
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
      day: dashboardDateParts(day).weekday.toUpperCase(),
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
      detail: `${charge.booking?.orderCode || charge.bookingId} - ${maskName(charge.driver?.name, 'Driver')} - ${minutesAgo(charge.createdAt, now)}`,
    })),
    ...activeDelayedBookings.map((booking) => ({
      severity: 'warning',
      label: 'Route Delay',
      title: `${booking.orderCode || booking.id} needs dispatch review`,
      detail: `${maskName(booking.driver?.name, 'Unassigned')} - ${minutesAgo(booking.updatedAt, now)}`,
    })),
  ].slice(0, 4);

  return {
    generatedAt: now.toISOString(),
    timezone: DASHBOARD_TIMEZONE,
    stats,
    weeklyOrders,
    breakdown,
    demandHeatmap: buildDemandHeatmap(heatmapBookings),
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
      customer: maskName(booking.user?.name || booking.user?.email, 'Customer'),
      route: routeLabel(booking),
      driver: maskName(booking.driver?.name, 'Unassigned'),
      status: booking.status,
      etd: booking.eta ? `${booking.eta} mins` : minutesAgo(booking.updatedAt, now),
    })),
    systemLogs: recentAuditLogs.map((log) => ({
      title: String(log.action || '').replace(/_/g, ' '),
      desc: `${log.entityType} ${String(log.entityId || '').slice(0, 18)} - ${minutesAgo(log.createdAt, now)}`,
      badge: log.actorType,
    })),
    notificationHealth: {
      deliveredLast24h: notificationsLast24h,
    },
  };
}

module.exports = {
  ACTIVE_BOOKING_STATUSES,
  DASHBOARD_TIMEZONE,
  buildDemandHeatmap,
  getCommandCenterSnapshot,
  startOfDayInDashboardTimezone,
};
