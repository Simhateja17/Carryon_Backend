/**
 * Server-side image magic-byte validation.
 * Checks the first bytes of a buffer to verify it is a real image,
 * independent of client-supplied MIME type or file extension.
 */

const SIGNATURES = [
  { type: 'image/jpeg', ext: 'jpg', bytes: [0xFF, 0xD8, 0xFF] },
  { type: 'image/png',  ext: 'png', bytes: [0x89, 0x50, 0x4E, 0x47] },
  { type: 'image/webp', ext: 'webp', bytes: null, check: (buf) => buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50 },
  { type: 'image/heic', ext: 'heic', bytes: null, check: (buf) => buf.length >= 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70 },
];

/**
 * Detect the real image type from a buffer's magic bytes.
 * @param {Buffer} buffer - file content buffer
 * @returns {{ type: string, ext: string } | null} detected type or null if not a recognized image
 */
function detectImageType(buffer) {
  if (!buffer || buffer.length < 4) return null;

  for (const sig of SIGNATURES) {
    if (sig.bytes) {
      if (buffer.length >= sig.bytes.length && sig.bytes.every((b, i) => buffer[i] === b)) {
        return { type: sig.type, ext: sig.ext };
      }
    } else if (sig.check && sig.check(buffer)) {
      return { type: sig.type, ext: sig.ext };
    }
  }
  return null;
}

/**
 * Validate a multer file object has valid image magic bytes.
 * Returns the detected image info or null if invalid.
 * @param {object} file - multer file with buffer property
 * @returns {{ type: string, ext: string } | null}
 */
function validateImageMagicBytes(file) {
  if (!file || !file.buffer) return null;
  return detectImageType(file.buffer);
}

module.exports = { detectImageType, validateImageMagicBytes };
