const { Router } = require('express');
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { recordAudit } = require('../services/auditLog');
const {
  NOTIFICATION_SETTINGS_KEY,
  FLEET_SETTINGS_KEY,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_FLEET_SETTINGS,
  getAdminSetting,
  mergeFleetSettings,
  sanitizeNotificationSettings,
  sanitizeFleetSettings,
  setAdminSettingTx,
} = require('../services/adminSettings');
const { searchPlaces } = require('../services/locationProvider');
const { clearGeoFenceCache } = require('../services/geoFence');
const { VEHICLE_CATALOG, normalizeVehicleType } = require('../services/businessConfig');

const router = Router();

function validateCityQuery(value) {
  const query = String(value || '').trim();
  if (!query || query.length < 2) {
    throw new AppError('query must be at least 2 characters', 400);
  }
  if (query.length > 120) {
    throw new AppError('query is too long', 400);
  }
  return query;
}

function sinceHours(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

function minutesAgo(date) {
  if (!date) return '--';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

router.get('/notifications', async (_req, res, next) => {
  try {
    const [settings, totalDrivers, onlineDrivers, adminsAudit, notificationCount, auditItems] =
      await Promise.all([
        getAdminSetting(NOTIFICATION_SETTINGS_KEY, DEFAULT_NOTIFICATION_SETTINGS),
        prisma.driver.count(),
        prisma.driver.count({ where: { isOnline: true } }),
        prisma.auditLog.count({ where: { actorType: 'ADMIN' } }),
        prisma.driverNotification.count({ where: { createdAt: { gte: sinceHours(24) } } }),
        prisma.auditLog.findMany({
          where: { action: { in: ['ADMIN_NOTIFICATION_SETTINGS_UPDATED', 'ADMIN_BOOKING_CREATED'] } },
          orderBy: { createdAt: 'desc' },
          take: 4,
        }),
      ]);

    res.json({
      success: true,
      data: {
        settings,
        groups: [
          { type: 'admin', label: 'Admins', badge: 'ACTIVE', sub: `${adminsAudit || 1} Admin actors - Global Access` },
          { type: 'dispatch', label: 'Dispatchers', badge: 'ACTIVE', sub: `${onlineDrivers} online drivers - Live ops` },
          { type: 'driver', label: 'Drivers', badge: 'RESTRICTED', sub: `${totalDrivers} drivers - Mobile Only` },
        ],
        health: {
          deliveryRate: totalDrivers > 0 ? Math.min(99.9, (onlineDrivers / totalDrivers) * 100) : 0,
          deliveredLast24h: notificationCount,
        },
        auditItems: auditItems.map((item) => ({
          icon: item.action === 'ADMIN_NOTIFICATION_SETTINGS_UPDATED' ? 'edit' : 'plus',
          text: item.action.replace(/_/g, ' '),
          time: minutesAgo(item.createdAt),
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.put('/notifications', async (req, res, next) => {
  try {
    let nextSettings;
    try {
      nextSettings = sanitizeNotificationSettings(req.body);
    } catch (err) {
      return next(new AppError(err.message, 400));
    }

    const previous = await getAdminSetting(NOTIFICATION_SETTINGS_KEY, DEFAULT_NOTIFICATION_SETTINGS);
    const saved = await prisma.$transaction(async (tx) => {
      const setting = await setAdminSettingTx(tx, NOTIFICATION_SETTINGS_KEY, nextSettings);
      await recordAudit(tx, {
        actor: req.adminActor,
        action: 'ADMIN_NOTIFICATION_SETTINGS_UPDATED',
        entityType: 'AdminSetting',
        entityId: NOTIFICATION_SETTINGS_KEY,
        oldValue: previous,
        newValue: nextSettings,
      });
      return setting;
    });

    res.json({ success: true, data: saved.value });
  } catch (err) {
    next(err);
  }
});

router.post('/geocode-city', async (req, res, next) => {
  try {
    const query = validateCityQuery(req.body?.query);

    const results = await searchPlaces(query);
    if (!results || results.length === 0) {
      return next(new AppError('No results found for the given city name', 404));
    }

    const place = results[0];
    res.json({
      success: true,
      data: {
        latitude: place.latitude,
        longitude: place.longitude,
        formattedAddress: place.address,
        city: place.city,
        region: place.region,
        country: place.country,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/city-suggestions', async (req, res, next) => {
  try {
    const query = validateCityQuery(req.body?.query);
    const results = await searchPlaces(query);

    res.json({
      success: true,
      data: results.slice(0, 8).map((place) => {
        const mainText = place.city || place.label || place.address;
        const zone = place.region || place.country || place.address;
        return {
          placeId: place.placeId,
          mainText,
          description: [place.region, place.country].filter(Boolean).join(', ') || place.address,
          latitude: place.latitude,
          longitude: place.longitude,
          zone,
        };
      }).filter((place) => place.mainText && Number.isFinite(place.latitude) && Number.isFinite(place.longitude) && place.zone),
    });
  } catch (err) {
    next(err);
  }
});

// Seed missing Vehicle records from VEHICLE_CATALOG defaults (runs once per missing type)
async function seedMissingVehicles(existingVehicles) {
  const existingTypes = new Set();
  for (const v of existingVehicles) {
    const type = normalizeVehicleType(v.iconName);
    if (type) existingTypes.add(type);
  }
  const missing = VEHICLE_CATALOG.filter((entry) => !existingTypes.has(entry.type));
  if (missing.length === 0) return existingVehicles;

  const created = await prisma.$transaction(
    missing.map((entry) =>
      prisma.vehicle.create({
        data: {
          name: entry.label,
          description: `${entry.label} routes. Max payload ${entry.defaultPayloadKg}kg.`,
          capacity: `${entry.defaultPayloadKg}kg`,
          basePrice: entry.defaultBasePrice,
          pricePerKm: entry.defaultPricePerKm,
          iconName: entry.type.toLowerCase(),
          isAvailable: true,
        },
      })
    )
  );
  return [...existingVehicles, ...created];
}

router.get('/fleet', async (_req, res, next) => {
  try {
    const [persisted, activeByType, rawVehicles, auditItems] = await Promise.all([
      getAdminSetting(FLEET_SETTINGS_KEY, DEFAULT_FLEET_SETTINGS),
      prisma.driverVehicle.groupBy({ by: ['type'], _count: { type: true } }),
      prisma.vehicle.findMany({ select: { iconName: true, pricePerKm: true } }),
      prisma.auditLog.findMany({
        where: { action: 'ADMIN_FLEET_SETTINGS_UPDATED' },
        orderBy: { createdAt: 'desc' },
        take: 4,
      }),
    ]);

    // Ensure all 8 vehicle types exist in DB (first boot seed)
    const vehicles = await seedMissingVehicles(rawVehicles);

    const activeCounts = new Map(activeByType.map((entry) => [entry.type, entry._count.type]));
    // Build a map of DB pricePerKm by normalized vehicle type
    const dbPriceByType = new Map();
    for (const v of vehicles) {
      const type = normalizeVehicleType(v.iconName);
      if (type && v.pricePerKm > 0 && !dbPriceByType.has(type)) {
        dbPriceByType.set(type, v.pricePerKm);
      }
    }

    const settings = mergeFleetSettings(persisted);

    res.json({
      success: true,
      data: {
        settings: {
          ...settings,
          vehicleClasses: settings.vehicleClasses.map((entry) => {
            const catalogDefault = VEHICLE_CATALOG.find((c) => c.type === entry.type);
            return {
              ...entry,
              active: activeCounts.get(entry.type) || 0,
              // DB value > persisted setting value > catalog default
              pricePerKm: dbPriceByType.get(entry.type) || entry.pricePerKm || catalogDefault?.defaultPricePerKm || 1,
            };
          }),
        },
        currency: 'MYR',
        distanceUnit: 'km',
        auditItems: auditItems.map((item) => ({
          icon: 'edit',
          text: item.action.replace(/_/g, ' '),
          time: minutesAgo(item.createdAt),
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.put('/fleet', async (req, res, next) => {
  try {
    let nextSettings;
    try {
      nextSettings = sanitizeFleetSettings(req.body);
    } catch (err) {
      return next(new AppError(err.message, 400));
    }

    const previous = mergeFleetSettings(await getAdminSetting(FLEET_SETTINGS_KEY, DEFAULT_FLEET_SETTINGS));
    const saved = await prisma.$transaction(async (tx) => {
      const setting = await setAdminSettingTx(tx, FLEET_SETTINGS_KEY, nextSettings);

      // Write pricePerKm to Vehicle table (DB is source of truth for pricing)
      for (const vc of nextSettings.vehicleClasses) {
        if (vc.pricePerKm == null) continue;
        const catalogEntry = VEHICLE_CATALOG.find((c) => c.type === vc.type);
        const iconName = vc.type.toLowerCase();
        const existing = await tx.vehicle.findFirst({
          where: { OR: [{ iconName }, { iconName: vc.type }] },
          select: { id: true },
        });
        if (existing) {
          await tx.vehicle.update({
            where: { id: existing.id },
            data: { pricePerKm: vc.pricePerKm },
          });
        } else {
          await tx.vehicle.create({
            data: {
              name: catalogEntry?.label || vc.label,
              description: vc.description || '',
              capacity: '',
              basePrice: catalogEntry?.defaultBasePrice || 0,
              pricePerKm: vc.pricePerKm,
              iconName,
              isAvailable: vc.enabled,
            },
          });
        }
      }

      await recordAudit(tx, {
        actor: req.adminActor,
        action: 'ADMIN_FLEET_SETTINGS_UPDATED',
        entityType: 'AdminSetting',
        entityId: FLEET_SETTINGS_KEY,
        oldValue: previous,
        newValue: nextSettings,
      });
      return setting;
    });

    clearGeoFenceCache();
    res.json({ success: true, data: saved.value });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
