const SUPPORTED_LANGUAGE_CODES = new Set(['en', 'ms', 'ta', 'zh']);
const DEFAULT_LANGUAGE_CODE = 'en';

function normalizeLanguageCode(language) {
  const code = typeof language === 'string' ? language.trim().toLowerCase() : '';
  return SUPPORTED_LANGUAGE_CODES.has(code) ? code : DEFAULT_LANGUAGE_CODE;
}

function isSupportedLanguageCode(language) {
  return typeof language === 'string' && SUPPORTED_LANGUAGE_CODES.has(language.trim().toLowerCase());
}

module.exports = {
  DEFAULT_LANGUAGE_CODE,
  SUPPORTED_LANGUAGE_CODES,
  normalizeLanguageCode,
  isSupportedLanguageCode,
};

