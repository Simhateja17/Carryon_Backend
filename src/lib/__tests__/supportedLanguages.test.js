const {
  DEFAULT_LANGUAGE_CODE,
  normalizeLanguageCode,
  isSupportedLanguageCode,
} = require('../supportedLanguages');

describe('supported languages', () => {
  test('supports the launch language set', () => {
    expect(['en', 'ms', 'ta', 'zh'].every(isSupportedLanguageCode)).toBe(true);
  });

  test('normalizes unsupported languages to English', () => {
    expect(DEFAULT_LANGUAGE_CODE).toBe('en');
    expect(normalizeLanguageCode('hi')).toBe('en');
    expect(normalizeLanguageCode('')).toBe('en');
    expect(normalizeLanguageCode(null)).toBe('en');
  });

  test('trims and lowercases supported language codes', () => {
    expect(normalizeLanguageCode(' MS ')).toBe('ms');
    expect(normalizeLanguageCode('ZH')).toBe('zh');
  });
});

