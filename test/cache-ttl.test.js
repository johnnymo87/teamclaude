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
  assert.equal(applyCacheTtl(body, '1h'), body, 'explicit 5m anywhere: body untouched (1h must precede 5m)');
  const b2 = Buffer.from(JSON.stringify({
    system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'n', input: { cache_control: { type: 'ephemeral' } } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'r', cache_control: { type: 'ephemeral' } }] },
      { type: 'text', text: 'cache_control', cache_control: { type: 'ephemeral', ttl: '1h' } }, { type: 'text', text: 'y', cache_control: { type: 'ephemeral' } }] }],
    tools: [{ name: 't', cache_control: { type: 'ephemeral' } }],
  }));
  const out = JSON.parse(applyCacheTtl(b2, '1h').toString());
  assert.equal(out.system[0].cache_control.ttl, '1h');
  assert.equal(out.messages[0].content[0].input.cache_control.ttl, undefined, 'tool_use.input untouched');
  assert.equal(out.messages[1].content[0].content[0].cache_control.ttl, '1h', 'tool_result nested content');
  assert.equal(out.messages[1].content[1].cache_control.ttl, '1h');
  assert.equal(out.messages[1].content[2].cache_control.ttl, '1h');
  assert.equal(out.tools[0].cache_control.ttl, '1h');
  assert.equal(out.messages[1].content[1].text, 'cache_control', 'text untouched');
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
    input: 3, cache_read: 10, cache_write: 7, cache_write_5m: 2, cache_write_1h: 5, output: 4, util7d: 0.07,
    util7d_source: 'cached', util5h: null, bucket_util: null });
  const fromResp = JSON.parse(usageLogLine({ sessionKey: { session: 's', util7d: 0.12, util5h: 0.3 }, usage: {}, util7d: 0.07, bucketUtil: 0.5 }));
  assert.equal(fromResp.util7d, 0.12); assert.equal(fromResp.util7d_source, 'response');
  assert.equal(fromResp.util5h, 0.3); assert.equal(fromResp.bucket_util, 0.5);
  const f = join(dir, 'usage.jsonl');
  appendUsageLog({ account: 'a', usage: {} }, f); appendUsageLog({ account: 'b', usage: {} }, f);
  assert.equal(readFileSync(f, 'utf8').trim().split('\n').length, 2);
  appendUsageLog({ account: 'a', usage: {} }, undefined); // unset: no throw
});
