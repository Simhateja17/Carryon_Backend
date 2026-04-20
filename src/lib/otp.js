const OTP_LENGTH = 6;
const OTP_PATTERN = new RegExp(`^\\d{${OTP_LENGTH}}$`);

function normalizeOtp(value = '') {
  return String(value).trim();
}

function generateOtp() {
  const min = 10 ** (OTP_LENGTH - 1);
  return String(Math.floor(min + Math.random() * 9 * min));
}

function isValidOtp(value) {
  return OTP_PATTERN.test(normalizeOtp(value));
}

module.exports = {
  OTP_LENGTH,
  generateOtp,
  isValidOtp,
  normalizeOtp,
};
