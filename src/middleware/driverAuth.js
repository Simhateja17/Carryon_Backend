const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const prisma = require('../lib/prisma');
const { AppError } = require('./errorHandler');
const { normalizePhone, phoneLookupVariants } = require('../services/authOtp');

// JWKS client for Supabase ES256 token verification
const client = jwksClient({
  jwksUri: `${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
  cache: true,
  cacheMaxAge: 600000,
});

function getKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      console.error('[DriverAuth] Error getting signing key:', err.message);
      return callback(err);
    }
    callback(null, key.getPublicKey());
  });
}

function verifyToken(token) {
  return new Promise((resolve, reject) => {
    jwt.verify(token, getKey, { algorithms: ['ES256'] }, (err, decoded) => {
      if (err) {
        console.error('[DriverAuth] Token verification failed:', err.message);
        return reject(err);
      }
      resolve(decoded);
    });
  });
}

async function authenticateDriver(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    console.error('[DriverAuth] Authentication failed: missing/invalid Authorization header', {
      path: req.originalUrl,
      method: req.method,
      ip: req.ip,
    });
    return next(new AppError('Authentication required', 401));
  }

  try {
    const token = header.split(' ')[1];
    
    const decoded = await verifyToken(token);
    const email = decoded.email || '';
    const phone = normalizePhone(decoded.phone);
    if (!email && !phone) {
      console.error('[DriverAuth] Authentication failed: token decoded without email or phone', {
        path: req.originalUrl,
        method: req.method,
        supabaseId: decoded.sub || null,
      });
      return next(new AppError('Invalid token payload', 401));
    }

    const phoneMatches = !email && phone
      ? await prisma.driver.findMany({ where: { phone: { in: phoneLookupVariants(phone) } }, include: { vehicle: true }, take: 2 })
      : [];
    if (phoneMatches.length > 1) {
      return next(new AppError('Phone number is linked to multiple driver accounts. Please contact support.', 401));
    }
    const driver = email
      ? await prisma.driver.findUnique({ where: { email }, include: { vehicle: true } })
      : phoneMatches[0] || null;
    if (!driver) {
      console.log('[DriverAuth] No driver found for token identity - allowing registration flow');
      req.driver = null;
      req.driverEmail = email;
      req.driverPhone = phone;
      req.supabaseId = decoded.sub;
      return next();
    }

    console.log('[DriverAuth] Driver authenticated:', driver.id);
    req.driver = driver;
    req.driverEmail = driver.email || email;
    req.driverPhone = driver.phone || phone;
    req.supabaseId = decoded.sub;
    next();
  } catch (err) {
    console.error('[DriverAuth] Authentication error', {
      path: req.originalUrl,
      method: req.method,
      message: err.message,
      name: err.name,
    });
    next(new AppError('Invalid or expired token', 401));
  }
}

// Strict version — requires driver record to exist
function requireDriver(req, res, next) {
  if (!req.driver) {
    console.log('[DriverAuth] requireDriver failed - no driver record');
    return next(new AppError('Driver profile not found. Please register first.', 401));
  }
  next();
}

module.exports = { authenticateDriver, requireDriver };
