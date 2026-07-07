export const ACCESS_TOKEN_BYTES = 32;
export const ACCESS_TOKEN_PREFIX = 'at_';

function toBase64(bytes) {
  if (typeof btoa === 'function') {
    let binary = '';
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }

  throw new Error('No base64 encoder is available');
}

export function bytesToBase64Url(bytes) {
  return toBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function createAccessToken(bytes) {
  const tokenBytes = bytes || new Uint8Array(ACCESS_TOKEN_BYTES);

  if (!bytes) {
    if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== 'function') {
      throw new Error('Crypto random generator is not available');
    }
    globalThis.crypto.getRandomValues(tokenBytes);
  }

  return ACCESS_TOKEN_PREFIX + bytesToBase64Url(tokenBytes);
}

export function getAccessTokenPrefix(token, visibleChars = 12) {
  return String(token || '').slice(0, visibleChars);
}

export async function hashAccessToken(token) {
  if (!globalThis.crypto || !globalThis.crypto.subtle) {
    throw new Error('Crypto digest API is not available');
  }

  const input = new TextEncoder().encode(String(token || ''));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
