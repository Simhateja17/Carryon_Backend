const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const prisma = require('../lib/prisma');
const { AppError } = require('./errorHandler');

// JWKS client for Supabase ES256 token verification
const client = jwksClient({
  jwksUri: `${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
  cache: true,
  cacheMaxAge: 600000,
});

console.log('[DriverAuth] JWKS URI:', `${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`);

function getKey(header, callback) {
  console.log('[DriverAuth] Getting signing key for kid:', header.kid);
  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      console.error('[DriverAuth] Error getting signing key:', err.message);
      return callback(err);
    }
    console.log('[DriverAuth] Successfully got signing key');
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
      console.log('[DriverAuth] Token verified successfully for email:', decoded.email);
      resolve(decoded);
    });
  });
}

async function authenticateDriver(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    console.log('[DriverAuth] No Authorization header or invalid format');
    return next(new AppError('Authentication required', 401));
  }

  try {
    const token = header.split(' ')[1];
    console.log('[DriverAuth] Verifying token (first 50 chars):', token.substring(0, 50) + '...');
    
    const decoded = await verifyToken(token);
    const email = decoded.email;

    const driver = await prisma.driver.findUnique({ where: { email }, include: { vehicle: true } });
    if (!driver) {
      console.log('[DriverAuth] No driver found for email:', email, '- allowing registration flow');
      req.driver = null;
      req.driverEmail = email;
      req.supabaseId = decoded.sub;
      return next();
    }

    console.log('[DriverAuth] Driver authenticated:', driver.id);
    req.driver = driver;
    req.driverEmail = email;
    req.supabaseId = decoded.sub;
    next();
  } catch (err) {
    console.error('[DriverAuth] Authentication error:', err.message);
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
