const prisma = require('../lib/prisma');

const NOTIFICATION_SETTINGS_KEY = 'notificationSettings';

const DEFAULT_NOTIFICATION_SETTINGS = {
  alerts: [
    {
      type: 'delay',
      label: 'Critical Delays',
      sub: 'Shipment is >2 hours behind schedule',
      sms: true,
      push: true,
      email: false,
    },
    {
      type: 'order',
      label: 'New Orders',
      sub: 'When a client places a new delivery request',
      sms: false,
      push: true,
      email: true,
    },
    {
      type: 'offline',
      label: 'Driver Offline',
      sub: 'Sudden disconnect during active duty',
      sms: true,
      push: true,
      email: false,
    },
    {
      type: 'fuel',
      label: 'Low Fuel Warnings',
      sub: 'Telematics detect low operational readiness',
      sms: false,
      push: true,
      email: false,
    },
  ],
};

const VALID_ALERT_TYPES = new Set(['delay', 'order', 'offline', 'fuel']);

function sanitizeNotificationSettings(input) {
  if (!input || !Array.isArray(input.alerts)) {
    throw new Error('alerts must be an array');
  }

  return {
    alerts: input.alerts.map((alert) => {
      const type = String(alert.type || '').trim();
      if (!VALID_ALERT_TYPES.has(type)) {
        throw new Error('Invalid alert type');
      }

      return {
        type,
        label: String(alert.label || '').trim().slice(0, 80),
        sub: String(alert.sub || '').trim().slice(0, 160),
        sms: Boolean(alert.sms),
        push: Boolean(alert.push),
        email: Boolean(alert.email),
      };
    }),
  };
}

async function getAdminSetting(key, fallback) {
  const row = await prisma.adminSetting.findUnique({ where: { key } });
  return row?.value || fallback;
}

async function setAdminSettingTx(tx, key, value) {
  return tx.adminSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

module.exports = {
  NOTIFICATION_SETTINGS_KEY,
  DEFAULT_NOTIFICATION_SETTINGS,
  sanitizeNotificationSettings,
  getAdminSetting,
  setAdminSettingTx,
};
