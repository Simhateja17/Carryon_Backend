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

// Routes
console.log('[app] Mounting routes...');
app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/users', require('./routes/user.routes'));
app.use('/api/addresses', require('./routes/address.routes'));
app.use('/api/bookings', require('./routes/booking.routes'));
app.use('/api/vehicles', require('./routes/vehicle.routes'));
console.log('[app] Routes mounted: /api/auth, /api/users, /api/addresses, /api/bookings, /api/vehicles');

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
