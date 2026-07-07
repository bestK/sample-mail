import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCESS_TOKEN_PREFIX,
  bytesToBase64Url,
  createAccessToken,
  getAccessTokenPrefix,
  hashAccessToken,
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
