import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTtlRule, ttlForRequest, applyCacheTtl, sessionHeaders, appendUsageLog, usageLogLine } from '../src/cache-ttl.js';

const dir = mkdtempSync(join(tmpdir(), 'tc-ttl-'));

test('missing or unset file is inert', () => {
  assert.equal(loadTtlRule(undefined).sessions.size, 0);
  assert.equal(loadTtlRule(join(dir, 'nope.json')).sessions.size, 0);
  assert.equal(ttlForRequest({ 'x-session-affinity': 'ses_a' }, loadTtlRule(join(dir, 'nope.json'))), null);
});

test('malformed file is inert', () => {
  const f = join(dir, 'bad.json'); writeFileSync(f, '{not json');
  assert.equal(loadTtlRule(f).sessions.size, 0);
});

test('matches session, x-session-id and parent; hot-reloads on mtime change', () => {
  const f = join(dir, 'rule.json');
  writeFileSync(f, JSON.stringify({ ttl: '1h', sessions: ['ses_a'] }));
  let rule = loadTtlRule(f);
  assert.equal(ttlForRequest({ 'x-session-affinity': 'ses_a' }, rule), '1h');
  assert.equal(ttlForRequest({ 'x-session-id': 'ses_a' }, rule), '1h');
  assert.equal(ttlForRequest({ 'x-session-affinity': 'ses_child', 'x-parent-session-id': 'ses_a' }, rule), '1h');
  assert.equal(ttlForRequest({ 'x-session-affinity': 'ses_b' }, rule), null);
  assert.equal(ttlForRequest({}, rule), null);
  writeFileSync(f, JSON.stringify({ sessions: ['ses_b'] }));
  const t = new Date(Date.now() + 5000); utimesSync(f, t, t);
  rule = loadTtlRule(f);
  assert.equal(ttlForRequest({ 'x-session-affinity': 'ses_a' }, rule), null);
  assert.equal(ttlForRequest({ 'x-session-affinity': 'ses_b' }, rule), '1h', 'ttl defaults to 1h');
});

test('applyCacheTtl sets ttl on every ephemeral cache_control without one', () => {
  const body = Buffer.from(JSON.stringify({
    system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'cache_control', cache_control: { type: 'ephemeral', ttl: '5m' } },
      { type: 'text', text: 'y', cache_control: { type: 'ephemeral' } }] }],
    tools: [{ name: 't', cache_control: { type: 'ephemeral' } }],
  }));
  const out = JSON.parse(applyCacheTtl(body, '1h').toString());
  assert.equal(out.system[0].cache_control.ttl, '1h');
  assert.equal(out.messages[0].content[0].cache_control.ttl, '5m', 'explicit client ttl kept');
  assert.equal(out.messages[0].content[1].cache_control.ttl, '1h');
  assert.equal(out.tools[0].cache_control.ttl, '1h');
  assert.equal(out.messages[0].content[0].text, 'cache_control', 'text untouched');
});

test('applyCacheTtl returns the same buffer when unchanged or not JSON', () => {
  const plain = Buffer.from(JSON.stringify({ messages: [] }));
  assert.equal(applyCacheTtl(plain, '1h'), plain);
  const junk = Buffer.from('not json');
  assert.equal(applyCacheTtl(junk, '1h'), junk);
  assert.equal(applyCacheTtl(plain, null), plain);
});

test('sessionHeaders', () => {
  assert.deepEqual(sessionHeaders({ 'x-session-affinity': 's', 'x-parent-session-id': 'p' }), { session: 's', parent: 'p' });
  assert.deepEqual(sessionHeaders({}), { session: null, parent: null });
});

test('usage ledger line and append', () => {
  const line = JSON.parse(usageLogLine({ account: 'a', bucket: 'unified7d', model: 'claude-opus-5-5', sessionKey: { session: 's', parent: null },
    usage: { input_tokens: 3, cache_read_input_tokens: 10, cache_creation_input_tokens: 7, cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 5 }, output_tokens: 4 },
    util7d: 0.07, now: 0 }));
  assert.deepEqual(line, { ts: '1970-01-01T00:00:00.000Z', account: 'a', bucket: 'unified7d', model: 'claude-opus-5-5', session: 's', parent: null,
    input: 3, cache_read: 10, cache_write: 7, cache_write_5m: 2, cache_write_1h: 5, output: 4, util7d: 0.07 });
  const f = join(dir, 'usage.jsonl');
  appendUsageLog({ account: 'a', usage: {} }, f); appendUsageLog({ account: 'b', usage: {} }, f);
  assert.equal(readFileSync(f, 'utf8').trim().split('\n').length, 2);
  appendUsageLog({ account: 'a', usage: {} }, undefined); // unset: no throw
});
