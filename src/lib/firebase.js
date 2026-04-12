const admin = require('firebase-admin');
const prisma = require('./prisma');

const INVALID_TOKEN_ERROR_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

function isInvalidTokenError(error) {
  return !!error?.code && INVALID_TOKEN_ERROR_CODES.has(error.code);
}

// Initialize Firebase Admin SDK
// Supports both:
// 1. GOOGLE_APPLICATION_CREDENTIALS env var (path to service-account.json)
// 2. FIREBASE_SERVICE_ACCOUNT env var (JSON string of service account)
// 3. service-account.json file in project root

function initializeFirebase() {
  if (admin.apps.length > 0) {
    return admin.apps[0];
  }

  try {
    // Option 1: FIREBASE_SERVICE_ACCOUNT env var (JSON string — best for Render)
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      console.log('[firebase] Initialized with FIREBASE_SERVICE_ACCOUNT env var');
      return admin.app();
    }

    // Option 2: GOOGLE_APPLICATION_CREDENTIALS env var (path to file)
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
      });
      console.log('[firebase] Initialized with GOOGLE_APPLICATION_CREDENTIALS');
      return admin.app();
    }

    // Option 3: service-account.json in project root
    const path = require('path');
    const fs = require('fs');
    const saPath = path.join(__dirname, '../../service-account.json');
    if (fs.existsSync(saPath)) {
      const serviceAccount = require(saPath);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      console.log('[firebase] Initialized with service-account.json file');
      return admin.app();
    }

    console.warn('[firebase] No Firebase credentials found. Push notifications will not work.');
    console.warn('[firebase] Set FIREBASE_SERVICE_ACCOUNT env var or place service-account.json in backend root.');
    return null;
  } catch (err) {
    console.error('[firebase] Failed to initialize:', err.message);
    return null;
  }
}

initializeFirebase();

/**
 * Send FCM push notification to multiple device tokens.
 * @param {string[]} tokens - Array of FCM device tokens
 * @param {object} notification - { title, body }
 * @param {object} [data] - Optional data payload
 * @returns {Promise<{ successCount: number, failureCount: number, failedTokens: string[], invalidTokens: string[], cleanedInvalidTokens: number }>}
 */
async function sendPushNotifications(tokens, notification, data = {}) {
  if (admin.apps.length === 0) {
    console.warn('[firebase] Not initialized — skipping push notification');
    return {
      successCount: 0,
      failureCount: tokens.length,
      failedTokens: tokens,
      invalidTokens: [],
      cleanedInvalidTokens: 0,
    };
  }

  if (!tokens || tokens.length === 0) {
    return {
      successCount: 0,
      failureCount: 0,
      failedTokens: [],
      invalidTokens: [],
      cleanedInvalidTokens: 0,
    };
  }

  // Convert all data values to strings (FCM requirement)
  const stringData = {};
  for (const [key, value] of Object.entries(data)) {
    stringData[key] = String(value);
  }

  const message = {
    notification: {
      title: notification.title,
      body: notification.body,
    },
    data: stringData,
    android: {
      priority: 'high',
      notification: {
        channelId: 'carryon_notifications',
        sound: 'default',
      },
    },
    apns: {
      payload: {
        aps: {
          alert: {
            title: notification.title,
            body: notification.body,
          },
          sound: 'default',
          badge: 1,
        },
      },
    },
  };

  const results = {
    successCount: 0,
    failureCount: 0,
    failedTokens: [],
    invalidTokens: [],
    cleanedInvalidTokens: 0,
  };

  // Use sendEachForMulticast for batch sending
  if (tokens.length === 1) {
    try {
      await admin.messaging().send({ ...message, token: tokens[0] });
      results.successCount = 1;
    } catch (err) {
      console.error(`[firebase] Failed to send to token: ${err.message}`);
      results.failureCount = 1;
      results.failedTokens.push(tokens[0]);
      if (isInvalidTokenError(err)) {
        results.invalidTokens.push(tokens[0]);
      }
    }
  } else {
    try {
      const response = await admin.messaging().sendEachForMulticast({
        ...message,
        tokens,
      });
      results.successCount = response.successCount;
      results.failureCount = response.failureCount;
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          console.error(`[firebase] Failed to send to token ${idx}: ${resp.error?.message}`);
          results.failedTokens.push(tokens[idx]);
          if (isInvalidTokenError(resp.error)) {
            results.invalidTokens.push(tokens[idx]);
          }
        }
      });
    } catch (err) {
      console.error(`[firebase] Batch send failed: ${err.message}`);
      results.failureCount = tokens.length;
      results.failedTokens = [...tokens];
    }
  }

  const uniqueInvalidTokens = Array.from(new Set(results.invalidTokens));
  results.invalidTokens = uniqueInvalidTokens;
  if (uniqueInvalidTokens.length > 0) {
    try {
      const cleanupResult = await prisma.driver.updateMany({
        where: { fcmToken: { in: uniqueInvalidTokens } },
        data: { fcmToken: null },
      });
      results.cleanedInvalidTokens = cleanupResult.count;
      console.log(
        `[firebase] Cleared ${cleanupResult.count} invalid FCM token(s) from Driver table`
      );
    } catch (err) {
      console.error('[firebase] Failed to cleanup invalid FCM tokens:', err.message);
    }
  }

  console.log(`[firebase] Push results: ${results.successCount} sent, ${results.failureCount} failed`);
  return results;
}

module.exports = { sendPushNotifications };
