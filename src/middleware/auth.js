const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const prisma = require('../lib/prisma');
const { AppError } = require('./errorHandler');

// JWKS client for Supabase ES256 token verification
const client = jwksClient({
  jwksUri: `${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
  cache: true,
  cacheMaxAge: 600000, // 10 minutes
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

// Verifies Supabase JWT and resolves Prisma User record
async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    console.error('[auth-mw] authenticate failed: missing/invalid Authorization header', {
      path: req.originalUrl,
      method: req.method,
      ip: req.ip,
    });
    return next(new AppError('Authentication required', 401));
  }

  try {
    const token = header.split(' ')[1];
    const decoded = await verifyToken(token);
    const email = decoded.email;
    if (!email) {
      console.error('[auth-mw] authenticate failed: token decoded without email', {
        path: req.originalUrl,
        method: req.method,
        supabaseId: decoded.sub || null,
      });
      return next(new AppError('Invalid token payload', 401));
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      console.error('[auth-mw] authenticate failed: user not found in Prisma', {
        path: req.originalUrl,
        method: req.method,
        email,
      });
      return next(new AppError('User not found. Please sync your account first.', 401));
    }

    req.user = {
      userId: user.id,
      supabaseId: decoded.sub,
      email: user.email,
      name: user.name,
      phone: user.phone,
    };
    next();
  } catch (err) {
    console.error('[auth-mw] authenticate failed: token verification error', {
      path: req.originalUrl,
      method: req.method,
      message: err.message,
      name: err.name,
    });
    next(new AppError('Invalid or expired token', 401));
  }
}

// Lightweight version that only verifies JWT without DB lookup
async function authenticateToken(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    console.error('[auth-mw] authenticateToken failed: missing/invalid Authorization header', {
      path: req.originalUrl,
      method: req.method,
      ip: req.ip,
    });
    return next(new AppError('Authentication required', 401));
  }

  try {
    const token = header.split(' ')[1];
    const decoded = await verifyToken(token);
    if (!decoded.email) {
      console.error('[auth-mw] authenticateToken failed: token decoded without email', {
        path: req.originalUrl,
        method: req.method,
        supabaseId: decoded.sub || null,
      });
      return next(new AppError('Invalid token payload', 401));
    }
    req.user = {
      supabaseId: decoded.sub,
      email: decoded.email,
    };
    next();
  } catch (err) {
    console.error('[auth-mw] authenticateToken failed: token verification error', {
      path: req.originalUrl,
      method: req.method,
      message: err.message,
      name: err.name,
    });
    next(new AppError('Invalid or expired token', 401));
  }
}

module.exports = { authenticate, authenticateToken };
