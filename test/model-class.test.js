import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelClass } from '../src/account-manager.js';

test('modelClass maps opus/sonnet wire + provider-prefixed ids', () => {
  assert.equal(modelClass('claude-opus-4-8'), 'opus');
  assert.equal(modelClass('anthropic/claude-opus-4-8'), 'opus');
  assert.equal(modelClass('claude-sonnet-4-5'), 'sonnet');
  assert.equal(modelClass('Opus'), 'opus');        // display_name form
  assert.equal(modelClass('Sonnet'), 'sonnet');
  assert.equal(modelClass('claude-haiku-4'), null);
  assert.equal(modelClass(null), null);
  assert.equal(modelClass(''), null);
});
