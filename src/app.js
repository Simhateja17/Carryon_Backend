const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const {
  legacyApiHeaders,
  mountVersionedMiddleware,
  mountVersionedRoute,
} = require('./routes/mountApiRoutes');

// Initialize Firebase Admin SDK early
require('./lib/firebase');

const app = express();

// Middleware
const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map(s => s.trim())
  : [];
const corsOptions = allowedOrigins.length > 0
  ? { origin: allowedOrigins, credentials: true }
  : (process.env.NODE_ENV === 'production' ? { origin: false } : undefined);
app.use(cors(corsOptions));
app.use(helmet());
app.use(morgan('dev'));
app.use('/api/v1/stripe/webhook', express.raw({ type: 'application/json' }), require('./routes/stripe-webhook.routes'));
app.use('/api/stripe/webhook', legacyApiHeaders, express.raw({ type: 'application/json' }), require('./routes/stripe-webhook.routes'));
app.use(express.json({ limit: '100kb' }));

// Rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 OTP requests per 15 min per IP
  message: { success: false, message: 'Too many attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
const walletLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 wallet operations per minute
  message: { success: false, message: 'Too many requests. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});
const locationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { success: false, message: 'Too many location requests. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});
mountVersionedMiddleware(app, '/auth/send-otp', authLimiter);
mountVersionedMiddleware(app, '/auth/verify-otp', authLimiter);
mountVersionedMiddleware(app, '/auth/refresh', authLimiter);
mountVersionedMiddleware(app, '/wallet/topup', walletLimiter);
mountVersionedMiddleware(app, '/wallet/pay', walletLimiter);
mountVersionedMiddleware(app, '/location', locationLimiter);

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Routes
console.log('[app] Mounting routes...');
mountVersionedRoute(app, '/auth', require('./routes/auth.routes'));
mountVersionedRoute(app, '/users', require('./routes/user.routes'));
mountVersionedRoute(app, '/addresses', require('./routes/address.routes'));
mountVersionedRoute(app, '/bookings', require('./routes/booking.routes'));
mountVersionedRoute(app, '/vehicles', require('./routes/vehicle.routes'));
mountVersionedRoute(app, '/location', require('./routes/location.routes'));
mountVersionedRoute(app, '/upload', require('./routes/upload.routes'));
mountVersionedRoute(app, '/promo', require('./routes/promo.routes'));
mountVersionedRoute(app, '/chat', require('./routes/chat.routes'));
mountVersionedRoute(app, '/wallet', require('./routes/wallet.routes'));
mountVersionedRoute(app, '/payments', require('./routes/payment.routes'));
mountVersionedRoute(app, '/support', require('./routes/support.routes'));
mountVersionedRoute(app, '/ratings', require('./routes/rating.routes'));
mountVersionedRoute(app, '/invoices', require('./routes/invoice.routes'));

// Driver routes
mountVersionedRoute(app, '/driver/auth', require('./routes/driver-auth.routes'));
mountVersionedRoute(app, '/driver/profile', require('./routes/driver-profile.routes'));
mountVersionedRoute(app, '/driver/documents', require('./routes/driver-documents.routes'));
mountVersionedRoute(app, '/driver/upload', require('./routes/driver-upload.routes'));
mountVersionedRoute(app, '/driver/vehicle', require('./routes/driver-vehicle.routes'));
mountVersionedRoute(app, '/driver/jobs', require('./routes/driver-jobs.routes'));
mountVersionedRoute(app, '/driver', require('./routes/driver-demand.routes'));
mountVersionedRoute(app, '/driver/earnings', require('./routes/driver-earnings.routes'));
mountVersionedRoute(app, '/driver/ratings', require('./routes/driver-ratings.routes'));
mountVersionedRoute(app, '/driver/support', require('./routes/driver-support.routes'));
mountVersionedRoute(app, '/driver/notifications', require('./routes/driver-notifications.routes'));
mountVersionedRoute(app, '/driver/chat', require('./routes/driver-chat.routes'));
mountVersionedRoute(app, '/driver/payouts', require('./routes/driver-payouts.routes'));

// Admin routes (protected by admin key)
const { adminAuth } = require('./middleware/adminAuth');
mountVersionedRoute(app, '/admin/notifications', require('./routes/admin-notifications.routes'), adminAuth);
mountVersionedRoute(app, '/admin/drivers', require('./routes/admin-drivers.routes'), adminAuth);
console.log('[app] All routes mounted');

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
