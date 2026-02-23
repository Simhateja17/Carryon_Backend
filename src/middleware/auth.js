const jwt = require('jsonwebtoken');
const { AppError } = require('./errorHandler');

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(new AppError('Authentication required', 401));
  }

  try {
    const token = header.split(' ')[1];
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    next(new AppError('Invalid or expired token', 401));
  }
}

module.exports = { authenticate };
