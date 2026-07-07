import test from 'node:test';
import assert from 'node:assert/strict';

import { serializeHeaders, parseStoredHeaders } from '../src/headers-debug.js';

test('serializeHeaders stores key/value header pairs', () => {
  const text = serializeHeaders([
    { key: 'Delivered-To', value: 'novenarudolf+oai_test@gmail.com' },
    { name: 'X-Forwarded-To', value: 'gmailrelay01@linkof.link' },
  ]);

  assert.deepEqual(JSON.parse(text), [
    { key: 'Delivered-To', value: 'novenarudolf+oai_test@gmail.com' },
    { key: 'X-Forwarded-To', value: 'gmailrelay01@linkof.link' },
  ]);
});

test('parseStoredHeaders returns [] for invalid json', () => {
  assert.deepEqual(parseStoredHeaders('not-json'), []);
});
