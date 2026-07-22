import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCESS_TOKEN_PREFIX,
  bytesToBase64Url,
  createAddressToken,
  createAccessToken,
  getAccessTokenPrefix,
  hashAccessToken,
  verifyAddressToken,
} from '../src/access-token.js';

test('bytesToBase64Url encodes without url-unsafe characters or padding', () => {
  assert.equal(bytesToBase64Url(new Uint8Array([251, 255, 255])), '-___');
});

test('createAccessToken uses the at_ prefix', () => {
  const token = createAccessToken(new Uint8Array(32));
  assert.ok(token.startsWith(ACCESS_TOKEN_PREFIX));
});

test('getAccessTokenPrefix returns the visible prefix only', () => {
  assert.equal(getAccessTokenPrefix('at_abcdefghijklmnopqrstuvwxyz', 8), 'at_abcde');
});

test('hashAccessToken returns a sha-256 hex digest', async () => {
  assert.equal(
    await hashAccessToken('at_test'),
    'a3b348496eeba57a0fb7cb6d35d4410c478868ca044cdc8f03df5629864ba97a'
  );
});

test('createAddressToken creates a verifiable address JWT', async () => {
  const token = await createAddressToken('User@Example.com', 123, 'secret');
  assert.equal(token.split('.').length, 3);

  const payload = await verifyAddressToken(token, 'secret');
  assert.deepEqual(payload, {
    address: 'user@example.com',
    address_id: 123,
  });
});

test('verifyAddressToken rejects a tampered token', async () => {
  const token = await createAddressToken('user@example.com', 123, 'secret');
  const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');

  assert.equal(await verifyAddressToken(tampered, 'secret'), null);
  assert.equal(await verifyAddressToken(token, 'wrong-secret'), null);
});
