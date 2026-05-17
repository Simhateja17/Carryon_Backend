const prisma = require('../lib/prisma');

const ALERT_LIMIT = 8;
const CASE_LIMIT = 8;
const PROFILE_LIMIT = 5;
const RECENT_DAYS = 7;
const PREVIOUS_DAYS = 14;

function startOfWindow(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

function asIso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function minutesAgo(date) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function timeOfDay(date) {
  return new Intl.DateTimeFormat('en', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'Asia/Kuala_Lumpur',
  }).format(new Date(date));
}

function routeLabel(booking) {
  return booking?.pickupAddress?.label
    || booking?.pickupAddress?.address
    || booking?.deliveryAddress?.label
    || booking?.deliveryAddress?.address
    || 'Unknown location';
}

function riskZoneLabel(booking) {
  const address = routeLabel(booking);
  return address.split(',').slice(-2).join(',').trim() || address;
}

function riskStatus(score) {
  if (score >= 70) return 'Pending Review';
  if (score >= 35) return 'Watchlist';
  return 'Resolved';
}

function riskLevel(score) {
  if (score >= 70) return 'HIGH RISK';
  if (score >= 35) return 'MED RISK';
  return 'LOW RISK';
}

function clampScore(score) {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function trendPercent(current, previous) {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function preventionRate(successfulEvents, totalEvents) {
  if (totalEvents <= 0) return 100;
  return Math.round((successfulEvents / totalEvents) * 1000) / 10;
}

function mapSosTicket(ticket) {
  return {
    id: `sos:${ticket.id}`,
    type: 'sos',
    title: ticket.subject || 'SOS Triggered',
    user: ticket.driver?.name || 'Unknown driver',
    subjectId: ticket.driver?.id || ticket.id,
    location: routeLabel(ticket.booking),
    occurredAt: asIso(ticket.createdAt),
    timeLabel: timeOfDay(ticket.createdAt),
    severity: 'Critical',
  };
}

function mapFailedEvent(event) {
  return {
    id: `event:${event.id}`,
    type: 'suspicious',
    title: String(event.command || 'Control event').replaceAll('_', ' '),
    user: event.booking?.driver?.name || event.booking?.user?.name || 'Unassigned',
    subjectId: event.booking?.driver?.id || event.booking?.user?.id || event.bookingId,
    location: routeLabel(event.booking),
    occurredAt: asIso(event.createdAt),
    timeLabel: timeOfDay(event.createdAt),
    severity: 'Warning',
  };
}

function mapPaymentFailure(booking) {
  return {
    id: `payment:${booking.id}`,
    type: 'payment',
    title: `${booking.paymentStatus} payment`,
    user: booking.user?.name || booking.user?.email || 'Unknown customer',
    subjectId: booking.user?.id || booking.id,
    location: riskZoneLabel(booking),
    occurredAt: asIso(booking.updatedAt),
    timeLabel: timeOfDay(booking.updatedAt),
    severity: booking.paymentStatus === 'FAILED' ? 'Critical' : 'Warning',
  };
}

function mapExtraChargeCase(charge) {
  const score = clampScore(55 + Number(charge.amount || 0));
  return {
    id: charge.id,
    user: charge.driver?.name || 'Unknown driver',
    subjectId: charge.driverId,
    ip: 'not captured',
    type: `${String(charge.type || 'Extra charge').replaceAll('_', ' ')} review`,
    score,
    status: riskStatus(score),
    createdAt: asIso(charge.createdAt),
  };
}

function mapFailedPaymentCase(booking) {
  const score = clampScore(booking.paymentStatus === 'FAILED' ? 82 : 48);
  return {
    id: booking.orderCode || booking.id,
    user: booking.user?.name || booking.user?.email || 'Unknown customer',
    subjectId: booking.user?.id || booking.id,
    ip: 'not captured',
    type: `${booking.paymentMethod} ${booking.paymentStatus}`.replaceAll('_', ' '),
    score,
    status: riskStatus(score),
    createdAt: asIso(booking.updatedAt),
  };
}

function buildProfileRows(bookings, supportTickets, extraCharges) {
  const profiles = new Map();

  function ensure(id, base) {
    if (!id) return null;
    if (!profiles.has(id)) {
      profiles.set(id, { id, name: base.name || 'Unknown profile', detailParts: [], score: 0 });
    }
    return profiles.get(id);
  }

  bookings.forEach((booking) => {
    const profile = ensure(booking.user?.id, { name: booking.user?.name || booking.user?.email });
    if (!profile) return;
    if (booking.status === 'CANCELLED') {
      profile.score += 12;
      profile.detailParts.push('Cancellation');
    }
    if (['FAILED', 'REFUNDED'].includes(booking.paymentStatus)) {
      profile.score += booking.paymentStatus === 'FAILED' ? 20 : 14;
      profile.detailParts.push(`${booking.paymentStatus} payment`);
    }
  });

  supportTickets.forEach((ticket) => {
    const profile = ensure(ticket.driver?.id, { name: ticket.driver?.name || ticket.driver?.email });
    if (!profile) return;
    profile.score += ticket.priority === 'URGENT' ? 28 : 12;
    profile.detailParts.push(ticket.subject || 'Support ticket');
  });

  extraCharges.forEach((charge) => {
    const profile = ensure(charge.driver?.id, { name: charge.driver?.name });
    if (!profile) return;
    profile.score += charge.status === 'PENDING' ? 16 : 8;
    profile.detailParts.push(`${charge.type} charge`);
  });

  return Array.from(profiles.values())
    .map((profile) => {
      const score = clampScore(profile.score);
      return {
        id: profile.id,
        name: profile.name,
        score,
        level: riskLevel(score),
        detail: profile.detailParts.slice(0, 2).join(', ') || 'Recent activity',
      };
    })
    .filter((profile) => profile.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, PROFILE_LIMIT);
}

async function getSafetyFraudSnapshot() {
  const recentStart = startOfWindow(RECENT_DAYS);
  const previousStart = startOfWindow(PREVIOUS_DAYS);

  const [
    sosTickets,
    failedEvents,
    paymentBookings,
    extraCharges,
    eventCounts,
    previousPaymentCount,
  ] = await Promise.all([
    prisma.driverSupportTicket.findMany({
      where: {
        OR: [
          { priority: 'URGENT' },
          { subject: { contains: 'SOS', mode: 'insensitive' } },
        ],
        createdAt: { gte: recentStart },
      },
      include: {
        driver: { select: { id: true, name: true, email: true, phone: true } },
        booking: {
          select: {
            id: true,
            orderCode: true,
            status: true,
            vehicleType: true,
            pickupAddress: true,
            deliveryAddress: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: ALERT_LIMIT,
    }),
    prisma.deliveryLifecycleEvent.findMany({
      where: {
        success: false,
        createdAt: { gte: recentStart },
      },
      include: {
        booking: {
          select: {
            id: true,
            orderCode: true,
            vehicleType: true,
            status: true,
            driver: { select: { id: true, name: true } },
            user: { select: { id: true, name: true, email: true } },
            pickupAddress: true,
            deliveryAddress: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: ALERT_LIMIT,
    }),
    prisma.booking.findMany({
      where: {
        paymentStatus: { in: ['FAILED', 'REFUNDED'] },
        updatedAt: { gte: recentStart },
      },
      include: {
        user: { select: { id: true, name: true, email: true } },
        pickupAddress: true,
        deliveryAddress: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: CASE_LIMIT,
    }),
    prisma.bookingExtraCharge.findMany({
      where: {
        OR: [
          { status: 'PENDING' },
          { status: 'REJECTED', updatedAt: { gte: recentStart } },
        ],
      },
      include: {
        driver: { select: { id: true, name: true } },
        booking: {
          select: {
            id: true,
            orderCode: true,
            pickupAddress: true,
            deliveryAddress: true,
            user: { select: { id: true, name: true, email: true } },
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: CASE_LIMIT,
    }),
    prisma.deliveryLifecycleEvent.groupBy({
      by: ['success'],
      where: { createdAt: { gte: recentStart } },
      _count: { id: true },
    }),
    prisma.booking.count({
      where: {
        paymentStatus: { in: ['FAILED', 'REFUNDED'] },
        updatedAt: { gte: previousStart, lt: recentStart },
      },
    }),
  ]);

  const alerts = [
    ...sosTickets.map(mapSosTicket),
    ...failedEvents.map(mapFailedEvent),
    ...paymentBookings.map(mapPaymentFailure),
  ]
    .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
    .slice(0, ALERT_LIMIT);

  const cases = [
    ...extraCharges.map(mapExtraChargeCase),
    ...paymentBookings.map(mapFailedPaymentCase),
  ]
    .sort((a, b) => b.score - a.score || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, CASE_LIMIT);

  const failedEventCount = eventCounts.find((entry) => entry.success === false)?._count.id || 0;
  const successfulEventCount = eventCounts.find((entry) => entry.success === true)?._count.id || 0;
  const currentPaymentCount = paymentBookings.length;
  const highRiskZoneCounts = new Map();
  [...paymentBookings, ...extraCharges.map((charge) => charge.booking).filter(Boolean)]
    .forEach((booking) => {
      const zone = riskZoneLabel(booking);
      highRiskZoneCounts.set(zone, (highRiskZoneCounts.get(zone) || 0) + 1);
    });
  const [zoneName = 'No active risk zone', zoneCount = 0] = Array.from(highRiskZoneCounts.entries())
    .sort((a, b) => b[1] - a[1])[0] || [];
  const totalZoneSignals = Array.from(highRiskZoneCounts.values()).reduce((sum, count) => sum + count, 0);

  return {
    generatedAt: new Date().toISOString(),
    kpis: {
      activeSos: sosTickets.filter((ticket) => ['OPEN', 'IN_PROGRESS'].includes(ticket.status)).length,
      fraudTrendPct: trendPercent(currentPaymentCount + extraCharges.length, previousPaymentCount),
      highRiskZone: {
        label: zoneName,
        concentrationPct: totalZoneSignals > 0 ? Math.round((zoneCount / totalZoneSignals) * 100) : 0,
      },
      preventionRatePct: preventionRate(successfulEventCount, successfulEventCount + failedEventCount),
    },
    alerts,
    riskProfiles: buildProfileRows(paymentBookings, sosTickets, extraCharges),
    cases,
    system: {
      uptimeLabel: process.uptime() > 0 ? `${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m` : 'unknown',
      nodeLabel: process.env.RENDER_SERVICE_NAME || process.env.HOSTNAME || 'admin-api',
      lastUpdatedLabel: minutesAgo(new Date()),
    },
  };
}

module.exports = {
  getSafetyFraudSnapshot,
  preventionRate,
  riskStatus,
  trendPercent,
};
