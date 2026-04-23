const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

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
app.use('/api/auth/send-otp', authLimiter);
app.use('/api/auth/verify-otp', authLimiter);
app.use('/api/auth/refresh', authLimiter);
app.use('/api/wallet/topup', walletLimiter);
app.use('/api/wallet/pay', walletLimiter);
app.use('/api/location', locationLimiter);

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Routes
console.log('[app] Mounting routes...');
app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/users', require('./routes/user.routes'));
app.use('/api/addresses', require('./routes/address.routes'));
app.use('/api/bookings', require('./routes/booking.routes'));
app.use('/api/vehicles', require('./routes/vehicle.routes'));
app.use('/api/location', require('./routes/location.routes'));
app.use('/api/upload', require('./routes/upload.routes'));
app.use('/api/promo', require('./routes/promo.routes'));
app.use('/api/chat', require('./routes/chat.routes'));
app.use('/api/wallet', require('./routes/wallet.routes'));
app.use('/api/support', require('./routes/support.routes'));
app.use('/api/ratings', require('./routes/rating.routes'));
app.use('/api/invoices', require('./routes/invoice.routes'));

// Driver routes
app.use('/api/driver/auth', require('./routes/driver-auth.routes'));
app.use('/api/driver/profile', require('./routes/driver-profile.routes'));
app.use('/api/driver/documents', require('./routes/driver-documents.routes'));
app.use('/api/driver/vehicle', require('./routes/driver-vehicle.routes'));
app.use('/api/driver/jobs', require('./routes/driver-jobs.routes'));
app.use('/api/driver/earnings', require('./routes/driver-earnings.routes'));
app.use('/api/driver/ratings', require('./routes/driver-ratings.routes'));
app.use('/api/driver/support', require('./routes/driver-support.routes'));
app.use('/api/driver/notifications', require('./routes/driver-notifications.routes'));
app.use('/api/driver/chat', require('./routes/driver-chat.routes'));

// Admin routes (protected by admin key)
const { adminAuth } = require('./middleware/adminAuth');
app.use('/api/admin/notifications', adminAuth, require('./routes/admin-notifications.routes'));
app.use('/api/admin/drivers', adminAuth, require('./routes/admin-drivers.routes'));
console.log('[app] All routes mounted');

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
