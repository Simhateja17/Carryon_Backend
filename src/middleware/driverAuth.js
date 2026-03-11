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

function getKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

function verifyToken(token) {
  return new Promise((resolve, reject) => {
    jwt.verify(token, getKey, { algorithms: ['ES256'] }, (err, decoded) => {
      if (err) return reject(err);
      resolve(decoded);
    });
  });
}

async function authenticateDriver(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(new AppError('Authentication required', 401));
  }

  try {
    const token = header.split(' ')[1];
    const decoded = await verifyToken(token);
    const email = decoded.email;

    const driver = await prisma.driver.findUnique({ where: { email } });
    if (!driver) {
      req.driver = null;
      req.driverEmail = email;
      req.supabaseId = decoded.sub;
      return next();
    }

    req.driver = driver;
    req.driverEmail = email;
    req.supabaseId = decoded.sub;
    next();
  } catch {
    next(new AppError('Invalid or expired token', 401));
  }
}

// Strict version — requires driver record to exist
function requireDriver(req, res, next) {
  if (!req.driver) {
    return next(new AppError('Driver profile not found. Please register first.', 401));
  }
  next();
}

module.exports = { authenticateDriver, requireDriver };
