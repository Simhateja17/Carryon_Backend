const { randomInt } = require('crypto');

const OTP_LENGTH = 6;
const OTP_PATTERN = new RegExp(`^\\d{${OTP_LENGTH}}$`);

function normalizeOtp(value = '') {
  return String(value).trim();
}

function numericOtp(length) {
  const parsedLength = Number(length);
  if (!Number.isInteger(parsedLength) || parsedLength < 1) {
    throw new Error('OTP length must be a positive integer');
  }
  const min = 10 ** (parsedLength - 1);
  const max = 10 ** parsedLength;
  return String(randomInt(min, max));
}

function generateOtp() {
  return numericOtp(OTP_LENGTH);
}

function isValidOtp(value) {
  return OTP_PATTERN.test(normalizeOtp(value));
}

module.exports = {
  OTP_LENGTH,
  generateOtp,
  isValidOtp,
  normalizeOtp,
  numericOtp,
};
