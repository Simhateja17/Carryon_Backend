const { Router } = require('express');

const router = Router();

const APP_CONFIG = {
  carryon: {
    android: {
      minimumVersionEnv: 'CARRYON_ANDROID_MINIMUM_VERSION',
      defaultMinimumVersion: '1.0.2',
      storeUrlEnv: 'CARRYON_ANDROID_STORE_URL',
      defaultStoreUrl: 'https://play.google.com/store/apps/details?id=com.company.carryon_malaysia',
    },
    ios: {
      minimumVersionEnv: 'CARRYON_IOS_MINIMUM_VERSION',
      defaultMinimumVersion: '1.0.2',
      storeUrlEnv: 'CARRYON_IOS_STORE_URL',
    },
  },
  driver: {
    android: {
      minimumVersionEnv: 'DRIVER_ANDROID_MINIMUM_VERSION',
      defaultMinimumVersion: '1.0.1',
      storeUrlEnv: 'DRIVER_ANDROID_STORE_URL',
      defaultStoreUrl: 'https://play.google.com/store/apps/details?id=com.company.carryon.driver',
    },
    ios: {
      minimumVersionEnv: 'DRIVER_IOS_MINIMUM_VERSION',
      defaultMinimumVersion: '1.0.1',
      storeUrlEnv: 'DRIVER_IOS_STORE_URL',
    },
  },
};

router.get('/minimum-version', (req, res) => {
  const app = String(req.query.app || '').toLowerCase();
  const platform = String(req.query.platform || '').toLowerCase();
  const config = APP_CONFIG[app]?.[platform];

  if (!config) {
    return res.status(400).json({
      success: false,
      message: 'Valid app and platform query parameters are required.',
    });
  }

  return res.json({
    success: true,
    data: {
      minimumVersion: process.env[config.minimumVersionEnv] || config.defaultMinimumVersion,
      storeUrl: process.env[config.storeUrlEnv] || config.defaultStoreUrl || null,
    },
  });
});

module.exports = router;
