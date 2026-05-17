const prisma = require('../lib/prisma');

const ANALYTICS_TIMEZONE = 'Asia/Kuala_Lumpur';
const TIMEZONE_OFFSET_MINUTES = 8 * 60;
const ACTIVE_STATUSES = [
  'PENDING',
  'SEARCHING_DRIVER',
  'DRIVER_ASSIGNED',
  'DRIVER_ARRIVED',
  'PICKUP_DONE',
  'IN_TRANSIT',
  'ARRIVED_AT_DROP',
];
const DELIVERED_STATUS = 'DELIVERED';
const CANCELLED_STATUS = 'CANCELLED';
const PERIODS = new Set(['today', 'weekly', 'monthly']);

function startOfDayInAnalyticsTimezone(date) {
  const shifted = new Date(date.getTime() + TIMEZONE_OFFSET_MINUTES * 60 * 1000);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - TIMEZONE_OFFSET_MINUTES * 60 * 1000);
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function addMonths(date, months) {
  const copy = new Date(date);
  copy.setUTCMonth(copy.getUTCMonth() + months);
  return copy;
}

function analyticsDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ANALYTICS_TIMEZONE,
    month: 'short',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  return {
    month: parts.find((part) => part.type === 'month')?.value || '',
    day: parts.find((part) => part.type === 'day')?.value || '',
    weekday: parts.find((part) => part.type === 'weekday')?.value || '',
  };
}

function analyticsDateKey(date) {
  const shifted = new Date(date.getTime() + TIMEZONE_OFFSET_MINUTES * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function resolveAnalyticsWindow(period, now = new Date()) {
  const normalized = PERIODS.has(period) ? period : 'today';
  const todayStart = startOfDayInAnalyticsTimezone(now);
  const tomorrowStart = addDays(todayStart, 1);

  if (normalized === 'monthly') {
    const shifted = new Date(now.getTime() + TIMEZONE_OFFSET_MINUTES * 60 * 1000);
    shifted.setUTCDate(1);
    shifted.setUTCHours(0, 0, 0, 0);
    const start = new Date(shifted.getTime() - TIMEZONE_OFFSET_MINUTES * 60 * 1000);
    return { period: normalized, start, end: now, previousStart: addMonths(start, -1), previousEnd: start };
  }

  if (normalized === 'weekly') {
    const start = addDays(todayStart, -6);
    return { period: normalized, start, end: now, previousStart: addDays(start, -7), previousEnd: start };
  }

  return { period: normalized, start: todayStart, end: now, previousStart: addDays(todayStart, -1), previousEnd: todayStart, todayStart, tomorrowStart };
}

function percentageChange(current, previous) {
  if (!previous) return current ? 100 : 0;
  return ((current - previous) / previous) * 100;
}

function round(value, precision = 1) {
  const multiplier = 10 ** precision;
  return Math.round(value * multiplier) / multiplier;
}

function revenueFor(bookings) {
  return bookings
    .filter((booking) => booking.status !== CANCELLED_STATUS)
    .reduce((sum, booking) => sum + (booking.finalPrice || 0), 0);
}

function averageDeliveryMinutes(bookings) {
  const durations = bookings
    .filter((booking) => booking.status === DELIVERED_STATUS)
    .map((booking) => {
      if (booking.deliveredAt) {
        return (new Date(booking.deliveredAt).getTime() - new Date(booking.createdAt).getTime()) / 60000;
      }
      return booking.duration || null;
    })
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (!durations.length) return 0;
  return round(durations.reduce((sum, value) => sum + value, 0) / durations.length, 0);
}

function averageRating(bookings) {
  const ratings = bookings
    .map((booking) => booking.order?.rating)
    .filter((rating) => Number.isFinite(rating));
  if (!ratings.length) return 0;
  return round(ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length, 1);
}

function cancellationRate(bookings) {
  if (!bookings.length) return 0;
  const cancelled = bookings.filter((booking) => booking.status === CANCELLED_STATUS).length;
  return round((cancelled / bookings.length) * 100, 1);
}

function metric(value, previous, direction = 'higher') {
  const change = percentageChange(value, previous);
  return {
    value,
    previous,
    changePct: round(change, 1),
    direction,
    favorable: direction === 'lower' ? value <= previous : value >= previous,
  };
}

function buildTrend(bookings, start, end) {
  const byDate = new Map();
  for (let cursor = new Date(start); cursor <= end; cursor = addDays(cursor, 1)) {
    byDate.set(analyticsDateKey(cursor), { orders: 0, revenue: 0, date: new Date(cursor) });
  }

  for (const booking of bookings) {
    const key = analyticsDateKey(new Date(booking.createdAt));
    const bucket = byDate.get(key);
    if (!bucket) continue;
    bucket.orders += 1;
    if (booking.status !== CANCELLED_STATUS) bucket.revenue += booking.finalPrice || 0;
  }

  return Array.from(byDate.values()).map((bucket) => {
    const parts = analyticsDateParts(bucket.date);
    return {
      label: `${parts.day} ${parts.month}`.trim(),
      orders: bucket.orders,
      revenue: round(bucket.revenue, 2),
    };
  });
}

function buildOrderAnalytics(bookings, start) {
  return Array.from({ length: 7 }, (_, index) => {
    const date = addDays(start, index);
    const key = analyticsDateKey(date);
    const parts = analyticsDateParts(date);
    return {
      label: parts.weekday.toUpperCase(),
      value: bookings.filter((booking) => analyticsDateKey(new Date(booking.createdAt)) === key).length,
    };
  });
}

function buildBreakdown(bookings) {
  const total = bookings.length || 1;
  const delivered = bookings.filter((booking) => booking.status === DELIVERED_STATUS).length;
  const pending = bookings.filter((booking) => ACTIVE_STATUSES.includes(booking.status)).length;
  const cancelled = bookings.filter((booking) => booking.status === CANCELLED_STATUS).length;
  return [
    { label: 'DELIVERED', count: delivered, pct: round((delivered / total) * 100, 1) },
    { label: 'PENDING', count: pending, pct: round((pending / total) * 100, 1) },
    { label: 'CANCELLED', count: cancelled, pct: round((cancelled / total) * 100, 1) },
  ];
}

function compactZone(address) {
  const text = String(address?.address || address?.label || '').trim();
  if (!text) return 'UNKNOWN';
  const parts = text.split(',').map((part) => part.trim()).filter(Boolean);
  const candidate = parts.length > 1 ? parts[parts.length - 2] : parts[0];
  return candidate.replace(/\b\d{4,}\b/g, '').trim().slice(0, 24).toUpperCase() || 'UNKNOWN';
}

function buildZones(bookings) {
  const counts = new Map();
  for (const booking of bookings) {
    const zone = compactZone(booking.deliveryAddress);
    counts.set(zone, (counts.get(zone) || 0) + 1);
  }
  const max = Math.max(...counts.values(), 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([name, count]) => ({
      name,
      value: count,
      intensity: round(count / max, 2),
      status: count / max >= 0.8 ? 'Hot' : count / max >= 0.45 ? 'Active' : 'Stable',
    }));
}

function buildSupplyDemand(bookings, activeDrivers, now) {
  const recent = buildTrend(bookings, addDays(startOfDayInAnalyticsTimezone(now), -5), now).slice(-6);
  const maxOrders = Math.max(...recent.map((point) => point.orders), activeDrivers, 1);
  return recent.map((point) => ({
    label: point.label,
    demand: point.orders,
    supply: activeDrivers,
    ratio: round(point.orders / maxOrders, 2),
  }));
}

function buildInsights({ currentBookings, activeDrivers, now }) {
  const cancelled = currentBookings.filter((booking) => booking.status === CANCELLED_STATUS);
  const active = currentBookings.filter((booking) => ACTIVE_STATUSES.includes(booking.status));
  const stale = active.filter((booking) => now.getTime() - new Date(booking.updatedAt).getTime() > 60 * 60 * 1000);
  const insights = [];

  if (currentBookings.length && cancelled.length / currentBookings.length >= 0.08) {
    insights.push({
      severity: 'critical',
      title: 'Cancellation Spike',
      detail: `${cancelled.length} of ${currentBookings.length} orders cancelled in the selected window. Review dispatch and pricing friction.`,
    });
  }

  if (active.length > activeDrivers) {
    insights.push({
      severity: 'info',
      title: 'Driver Supply Pressure',
      detail: `${active.length} active orders are competing for ${activeDrivers} online drivers. Consider targeted driver nudges.`,
    });
  }

  if (stale.length) {
    insights.push({
      severity: 'warning',
      title: 'Stale Delivery Movement',
      detail: `${stale.length} active deliveries have not moved for over 60 minutes. Dispatch review recommended.`,
    });
  }

  if (!insights.length) {
    insights.push({
      severity: 'success',
      title: 'Operations Stable',
      detail: 'Cancellation, supply, and stale-delivery indicators are within the current operating thresholds.',
    });
  }

  return insights.slice(0, 3);
}

function formatVehicleType(type) {
  return String(type || 'CAR').replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildDriverPerformance(drivers, bookings) {
  const byDriver = new Map();
  for (const booking of bookings) {
    if (!booking.driverId) continue;
    const row = byDriver.get(booking.driverId) || { assigned: 0, cancelled: 0, delivered: 0 };
    row.assigned += 1;
    if (booking.status === CANCELLED_STATUS) row.cancelled += 1;
    if (booking.status === DELIVERED_STATUS) row.delivered += 1;
    byDriver.set(booking.driverId, row);
  }

  return drivers.map((driver) => {
    const row = byDriver.get(driver.id) || { assigned: 0, cancelled: 0, delivered: 0 };
    const cancelRate = row.assigned ? round((row.cancelled / row.assigned) * 100, 1) : 0;
    return {
      id: driver.id,
      name: driver.name,
      avatar: driver.photo,
      fleet: formatVehicleType(driver.vehicle?.type),
      acceptancePct: row.assigned ? round((row.delivered / row.assigned) * 100, 1) : 0,
      cancelRatePct: cancelRate,
      onTimePct: row.assigned ? round((row.delivered / row.assigned) * 100, 1) : 0,
      rating: round(driver.rating || 0, 1),
      status: driver.isOnline ? 'ACTIVE' : 'OFFLINE',
    };
  });
}

function buildOperationalLog(bookings, activeDrivers, now) {
  const today = startOfDayInAnalyticsTimezone(now);
  return Array.from({ length: 3 }, (_, index) => {
    const day = addDays(today, -index);
    const nextDay = addDays(day, 1);
    const rows = bookings.filter((booking) => booking.createdAt >= day && booking.createdAt < nextDay);
    const parts = analyticsDateParts(day);
    return {
      date: `${parts.month} ${parts.day}`.trim(),
      volume: rows.length,
      grossRevenue: round(revenueFor(rows), 2),
      resources: activeDrivers,
      avgTatMinutes: averageDeliveryMinutes(rows),
    };
  });
}

async function getAnalyticsSnapshot({ period = 'today', now = new Date() } = {}) {
  const window = resolveAnalyticsWindow(period, now);
  const lowerBound = window.previousStart < addDays(window.start, -6) ? window.previousStart : addDays(window.start, -6);

  const [currentBookings, previousBookings, trendBookings, activeDrivers, topDrivers, refundAgg, commissionAgg] = await Promise.all([
    prisma.booking.findMany({
      where: { createdAt: { gte: window.start, lt: window.end } },
      select: {
        id: true,
        driverId: true,
        status: true,
        finalPrice: true,
        discountAmount: true,
        duration: true,
        createdAt: true,
        updatedAt: true,
        deliveredAt: true,
        deliveryAddress: { select: { label: true, address: true } },
        order: { select: { rating: true } },
      },
    }),
    prisma.booking.findMany({
      where: { createdAt: { gte: window.previousStart, lt: window.previousEnd } },
      select: { status: true, finalPrice: true, duration: true, createdAt: true, deliveredAt: true, order: { select: { rating: true } } },
    }),
    prisma.booking.findMany({
      where: { createdAt: { gte: lowerBound, lt: window.end } },
      select: { status: true, finalPrice: true, createdAt: true },
    }),
    prisma.driver.count({ where: { isOnline: true } }),
    prisma.driver.findMany({
      orderBy: [{ isOnline: 'desc' }, { totalTrips: 'desc' }, { rating: 'desc' }],
      take: 5,
      select: { id: true, name: true, photo: true, isOnline: true, rating: true, totalTrips: true, vehicle: { select: { type: true } } },
    }),
    prisma.booking.aggregate({
      where: { status: CANCELLED_STATUS, updatedAt: { gte: window.start, lt: window.end } },
      _sum: { cancellationFee: true },
    }),
    prisma.driverWalletTransaction.aggregate({
      where: { type: 'DELIVERY_EARNING', createdAt: { gte: window.start, lt: window.end } },
      _sum: { platformFeeAmount: true },
    }),
  ]);

  const currentRevenue = revenueFor(currentBookings);
  const previousRevenue = revenueFor(previousBookings);
  const currentCancelRate = cancellationRate(currentBookings);
  const previousCancelRate = cancellationRate(previousBookings);
  const currentAvgDelivery = averageDeliveryMinutes(currentBookings);
  const previousAvgDelivery = averageDeliveryMinutes(previousBookings);
  const currentRating = averageRating(currentBookings);
  const previousRating = averageRating(previousBookings);
  const avgCommission = currentBookings.length ? (commissionAgg._sum.platformFeeAmount || 0) / currentBookings.length : 0;
  const refundRatio = currentRevenue ? ((refundAgg._sum.cancellationFee || 0) / currentRevenue) * 100 : 0;

  return {
    generatedAt: now.toISOString(),
    timezone: ANALYTICS_TIMEZONE,
    period: window.period,
    window: { start: window.start.toISOString(), end: window.end.toISOString() },
    metrics: {
      totalOrders: metric(currentBookings.length, previousBookings.length),
      totalRevenue: metric(round(currentRevenue, 2), round(previousRevenue, 2)),
      activeDrivers: { value: activeDrivers, previous: null, changePct: null, direction: 'higher', favorable: true },
      avgDeliveryMinutes: metric(currentAvgDelivery, previousAvgDelivery, 'lower'),
      cancelRatePct: metric(currentCancelRate, previousCancelRate, 'lower'),
      avgRating: metric(currentRating, previousRating),
    },
    trend: buildTrend(trendBookings, lowerBound, window.end),
    orderAnalytics: buildOrderAnalytics(trendBookings, addDays(startOfDayInAnalyticsTimezone(now), -6)),
    orderBreakdown: buildBreakdown(currentBookings),
    zones: buildZones(currentBookings),
    driverPerformance: buildDriverPerformance(topDrivers, currentBookings),
    profitability: {
      avgCommission: round(avgCommission, 2),
      discountImpact: round(currentBookings.reduce((sum, booking) => sum + (booking.discountAmount || 0), 0), 2),
      refundRatioPct: round(refundRatio, 2),
      netProfitMarginPct: currentRevenue ? round(((commissionAgg._sum.platformFeeAmount || 0) / currentRevenue) * 100, 1) : 0,
    },
    operationalLog: buildOperationalLog(trendBookings, activeDrivers, now),
    supplyDemand: buildSupplyDemand(trendBookings, activeDrivers, now),
    insights: buildInsights({ currentBookings, activeDrivers, now }),
  };
}

module.exports = {
  ACTIVE_STATUSES,
  ANALYTICS_TIMEZONE,
  averageDeliveryMinutes,
  buildBreakdown,
  buildTrend,
  getAnalyticsSnapshot,
  resolveAnalyticsWindow,
  startOfDayInAnalyticsTimezone,
};
