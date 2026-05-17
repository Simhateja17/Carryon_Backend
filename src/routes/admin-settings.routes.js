const { Router } = require('express');
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { recordAudit } = require('../services/auditLog');
const {
  NOTIFICATION_SETTINGS_KEY,
  DEFAULT_NOTIFICATION_SETTINGS,
  getAdminSetting,
  sanitizeNotificationSettings,
  setAdminSettingTx,
} = require('../services/adminSettings');
const { getNotificationSettingsSnapshot } = require('../services/adminNotificationSettings');
const {
  FleetSettingsValidationError,
  getFleetSettingsSnapshot,
  updateFleetSettings,
} = require('../services/adminFleetSettings');
const { searchPlaces } = require('../services/locationProvider');
const { clearGeoFenceCache } = require('../services/geoFence');

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

router.get('/notifications', async (_req, res, next) => {
  try {
    res.json({
      success: true,
      data: await getNotificationSettingsSnapshot(prisma),
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

router.get('/fleet', async (_req, res, next) => {
  try {
    res.json({
      success: true,
      data: await getFleetSettingsSnapshot(prisma),
    });
  } catch (err) {
    next(err);
  }
});

router.put('/fleet', async (req, res, next) => {
  try {
    const saved = await updateFleetSettings(req.body, req.adminActor, prisma);
    clearGeoFenceCache();
    res.json({ success: true, data: saved });
  } catch (err) {
    if (err instanceof FleetSettingsValidationError) {
      return next(new AppError(err.message, 400));
    }
    next(err);
  }
});

module.exports = router;
