import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLimitResponse } from '../src/limit-classify.js';

test('IP-throttle 429 is NOT a usage limit (back off, never mark scope)', () => {
  const r = classifyLimitResponse(429,
    { 'retry-after': '30' },
    { type: 'error', error: { type: 'rate_limit_error', message: 'Server is temporarily limiting requests (not your usage limit)' } });
  assert.equal(r.kind, 'throttle');
});

test('a structured per-account usage limit is recognized (explicit type)', () => {
  const r = classifyLimitResponse(429,
    {},
    { type: 'error', error: { type: 'usage_limit_error', message: 'The usage limit has been reached' } });
  assert.equal(r.kind, 'usage_limit');
});

test('[R2] the design PRIMARY shape: message-based usage limit inside a 200, shared rate_limit_error type', () => {
  const r = classifyLimitResponse(200, {},
    { type: 'error', error: { type: 'rate_limit_error', message: 'The usage limit has been reached' } });
  assert.equal(r.kind, 'usage_limit');   // must NOT collapse to unknown at status 200
});

test('unrecognized → unknown (caller backs off, never marks a scope)', () => {
  assert.equal(classifyLimitResponse(200, {}, { type: 'message_start' }).kind, 'unknown');
  assert.equal(classifyLimitResponse(500, {}, null).kind, 'unknown');
});
