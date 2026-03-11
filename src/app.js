const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const app = express();

// Middleware
app.use(cors());
app.use(helmet());
app.use(morgan('dev'));
app.use(express.json());

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
console.log('[app] All routes mounted');

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
