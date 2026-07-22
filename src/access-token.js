export const ACCESS_TOKEN_BYTES = 32;
export const ACCESS_TOKEN_PREFIX = 'at_';
export const ADDRESS_TOKEN_ALG = 'HS256';

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

function fromBase64(value) {
  if (typeof atob === 'function') {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(value, 'base64'));
  }

  throw new Error('No base64 decoder is available');
}

export function bytesToBase64Url(bytes) {
  return toBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function base64UrlToBytes(value) {
  const normalized = String(value || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return fromBase64(padded);
}

function textToBase64Url(value) {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function base64UrlToText(value) {
  return new TextDecoder().decode(base64UrlToBytes(value));
}

function constantTimeStringEqual(a, b) {
  const left = new TextEncoder().encode(String(a || ''));
  const right = new TextEncoder().encode(String(b || ''));
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);

  for (let i = 0; i < length; i++) {
    diff |= (left[i] || 0) ^ (right[i] || 0);
  }

  return diff === 0;
}

async function hmacSha256(data, secret) {
  if (!globalThis.crypto || !globalThis.crypto.subtle) {
    throw new Error('Crypto HMAC API is not available');
  }

  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(data));

  return bytesToBase64Url(new Uint8Array(signature));
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

export async function createAddressToken(address, addressId, secret) {
  const jwtSecret = String(secret || '').trim();
  if (!jwtSecret) {
    throw new Error('Address token secret is not configured');
  }

  const header = {
    alg: ADDRESS_TOKEN_ALG,
    typ: 'JWT',
  };
  const payload = {
    address: String(address || '').trim().toLowerCase(),
    address_id: Number.isSafeInteger(addressId) ? addressId : 0,
  };
  const signingInput = `${textToBase64Url(JSON.stringify(header))}.${textToBase64Url(JSON.stringify(payload))}`;
  const signature = await hmacSha256(signingInput, jwtSecret);

  return `${signingInput}.${signature}`;
}

export async function verifyAddressToken(token, secret) {
  const jwtSecret = String(secret || '').trim();
  if (!jwtSecret) return null;

  const parts = String(token || '').trim().split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) return null;

  const [encodedHeader, encodedPayload, signature] = parts;
  let header;
  let payload;

  try {
    header = JSON.parse(base64UrlToText(encodedHeader));
    payload = JSON.parse(base64UrlToText(encodedPayload));
  } catch {
    return null;
  }

  if (!header || header.alg !== ADDRESS_TOKEN_ALG) return null;
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = await hmacSha256(signingInput, jwtSecret);

  if (!constantTimeStringEqual(signature, expectedSignature)) return null;
  return payload && typeof payload === 'object' ? payload : null;
}
