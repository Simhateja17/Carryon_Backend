const { AppError } = require('../middleware/errorHandler');
const { maskPhone, normalizePhone } = require('./authOtp');

const DEFAULT_ENDPOINTS = [
  'https://smtpapi2.vocotext.com/isms_send_all_id.php',
  'https://ww3.isms.com.my/isms_send_all_id.php',
  'https://smtpapi.vocotext.com/isms_send_all_id.php',
];

const ISMS_SUCCESS_PATTERN = /^2000(?:$|[\s=:])/;

function requireHttpsEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch (_err) {
    throw new AppError('iSMS endpoint URL is invalid.', 503);
  }
  if (url.protocol !== 'https:') {
    throw new AppError('iSMS endpoint must use HTTPS.', 503);
  }
  return url.toString();
}

function isUnicodeMessage(message) {
  return /[^\x00-\x7F]/.test(message);
}

function ismsDestination(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw new AppError('A valid phone number is required.', 400);
  return normalized.slice(1);
}

function ismsEndpoints() {
  const endpoints = String(process.env.ISMS_SMS_ENDPOINTS || '')
    .split(',')
    .map((endpoint) => endpoint.trim())
    .filter(Boolean)
    .concat(DEFAULT_ENDPOINTS)
    .filter((endpoint, index, all) => all.indexOf(endpoint) === index);
  return endpoints.map(requireHttpsEndpoint);
}

function ismsConfig() {
  const username = process.env.ISMS_USERNAME;
  const password = process.env.ISMS_PASSWORD;
  const senderId = process.env.ISMS_SENDER_ID;
  const timeoutMs = Number(process.env.ISMS_SMS_TIMEOUT_MS || 1500);
  if (!username || !password) {
    throw new AppError('iSMS provider is not configured.', 503);
  }
  if (!senderId) {
    throw new AppError('iSMS sender ID is not configured.', 503);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 500 || timeoutMs > 4000) {
    throw new AppError('iSMS timeout is misconfigured.', 503);
  }
  return {
    username,
    password,
    senderId,
    timeoutMs,
  };
}

function parseIsmsResponse(body = '') {
  const text = String(body || '').trim();
  if (!text || ISMS_SUCCESS_PATTERN.test(text)) {
    return {
      ok: true,
      messageId: text.includes(':') ? text.split(':').slice(1).join(':').trim() : '',
      raw: text,
    };
  }
  const [code] = text.split(/\s|=/);
  return { ok: false, code: code || 'unknown', raw: text };
}

async function postToIsms(endpoint, params, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: controller.signal,
    });
    const body = await response.text();
    return {
      httpStatus: response.status,
      ...parseIsmsResponse(body),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function sendIsmsSms({ phone, message }) {
  const config = ismsConfig();
  const destination = ismsDestination(phone);
  const params = new URLSearchParams({
    un: config.username,
    pwd: config.password,
    dstno: destination,
    msg: message,
    type: isUnicodeMessage(message) ? '2' : '1',
    sendid: config.senderId,
    agreedterm: 'YES',
  });

  const failures = [];
  for (const endpoint of ismsEndpoints()) {
    try {
      const result = await postToIsms(endpoint, params, config.timeoutMs);
      if (result.ok) {
        return {
          provider: 'isms',
          endpoint,
          messageId: result.messageId,
          maskedPhone: maskPhone(phone),
        };
      }
      failures.push({ endpoint, code: result.code, status: result.httpStatus });
    } catch (err) {
      failures.push({ endpoint, code: err.name === 'AbortError' ? 'timeout' : 'request_failed' });
    }
  }

  console.error('[isms-sms] send failed', {
    phone: maskPhone(phone),
    failures,
  });
  throw new AppError('SMS provider failed to send verification code.', 502);
}

module.exports = {
  ismsDestination,
  parseIsmsResponse,
  sendIsmsSms,
};
