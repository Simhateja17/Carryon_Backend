const { Router } = require('express');
const { AppError } = require('../middleware/errorHandler');
const { sendAuthOtpSms } = require('../services/authSmsDelivery');
const { verifySupabaseAuthHook } = require('../services/supabaseAuthHookVerifier');

const router = Router();

function sendHookError(res, err) {
  const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  res.status(status).json({
    error: {
      http_code: status,
      message: status >= 500 ? 'Unable to send verification code.' : err.message,
    },
  });
}

router.post('/send-sms', async (req, res) => {
  try {
    verifySupabaseAuthHook(req);
    if (!req.body || typeof req.body !== 'object') {
      throw new AppError('Invalid Supabase auth hook payload.', 400);
    }
    await sendAuthOtpSms(req.body);
    res.status(200).end();
  } catch (err) {
    console.error('[auth-hooks] send-sms failed', {
      statusCode: err.statusCode || 500,
      message: err.message,
    });
    sendHookError(res, err);
  }
});

module.exports = router;
