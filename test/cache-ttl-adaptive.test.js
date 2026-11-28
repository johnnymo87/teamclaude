import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadTtlRule, ttlDecision, ttlForRequest, observeUsage, scoreGap, replayUsageLog,
  usageLogLine, _resetAdaptive,
} from '../src/cache-ttl.js';

const dir = mkdtempSync(join(tmpdir(), 'tc-ttl-adapt-'));
let n = 0;
function ruleFile(extra = {}) {
  const f = join(dir, `rule${n++}.json`);
  writeFileSync(f, JSON.stringify({
    ttl: '1h', sessions: [],
    adaptive: { enabled: true, minEvents: 3, onAbove: 100000, offBelow: -50000, windowHours: 24, replay: false },
    ...extra,
  }));
  return loadTtlRule(f);
}
const MIN = 60_000;
const T0 = Date.parse('2026-11-28T00:00:00Z');
const usage = (ctx) => ({ input_tokens: 10, cache_read_input_tokens: ctx - 10, cache_creation_input_tokens: 0 });
// Feed one session a request per entry of `gapsMin`, context `ctx` tokens each.
function feed(rule, session, gapsMin, { ctx = 100000, parent = null, model = 'm', start = T0 } = {}) {
  let t = start;
  observeUsage({ session, parent, model, usage: usage(ctx), now: t }, rule);
  for (const g of gapsMin) { t += g * MIN; observeUsage({ session, parent, model, usage: usage(ctx), now: t }, rule); }
  return t;
}

beforeEach(() => _resetAdaptive());

test('scoreGap follows the loss rule: 5-60 min gaps gain, others pay the 1h premium', () => {
  assert.equal(scoreGap({ gapMs: null, prevCtx: null, ctx: 50000 }), -30000, 'a first request is a full write');
  assert.equal(scoreGap({ gapMs: 2 * MIN, prevCtx: 100000, ctx: 101000 }), -600);
  assert.equal(scoreGap({ gapMs: 30 * MIN, prevCtx: 100000, ctx: 101000 }), 100000 - 600);
  assert.equal(scoreGap({ gapMs: 90 * MIN, prevCtx: 100000, ctx: 101000 }), -0.6 * 101000);
  // Context shrank by more than half (compaction): a cold write either way.
  assert.equal(scoreGap({ gapMs: 30 * MIN, prevCtx: 100000, ctx: 40000 }), -0.6 * 40000);
});

test('adaptive is inert unless enabled: the static rule decides', () => {
  const f = join(dir, 'plain.json'); writeFileSync(f, JSON.stringify({ ttl: '1h', sessions: ['ses_a'] }));
  const rule = loadTtlRule(f);
  feed(rule, 'ses_b', [30, 30, 30, 30]);
  assert.deepEqual(ttlDecision({ 'x-session-id': 'ses_b' }, rule, () => T0), { ttl: null, reason: null });
  assert.deepEqual(ttlDecision({ 'x-session-id': 'ses_a' }, rule, () => T0), { ttl: '1h', reason: 'list' });
});

test('an unlisted session whose gaps sit in 5-60 min is switched on', () => {
  const rule = ruleFile();
  const t = feed(rule, 'ses_b', [30, 20, 40]);
  assert.deepEqual(ttlDecision({ 'x-session-id': 'ses_b' }, rule, () => t), { ttl: '1h', reason: 'adaptive-on' });
});

test('before minEvents the static rule is the prior', () => {
  const rule = ruleFile({ sessions: ['ses_a'] });
  const t = feed(rule, 'ses_a', [90]);
  assert.deepEqual(ttlDecision({ 'x-session-id': 'ses_a' }, rule, () => t), { ttl: '1h', reason: 'prior-list' });
  assert.deepEqual(ttlDecision({ 'x-session-id': 'ses_z' }, rule, () => t), { ttl: null, reason: 'prior-none' });
});

test('a listed session in bursts more than an hour apart is switched off', () => {
  const rule = ruleFile({ sessions: ['ses_a'] });
  const t = feed(rule, 'ses_a', [2, 120, 2, 120, 2]);
  assert.deepEqual(ttlDecision({ 'x-session-id': 'ses_a' }, rule, () => t), { ttl: null, reason: 'adaptive-off' });
});

test('hysteresis: a score between the thresholds keeps the current state', () => {
  const rule = ruleFile();
  let t = feed(rule, 'ses_b', [30, 30, 30], { ctx: 100000 });
  assert.equal(ttlForRequest({ 'x-session-id': 'ses_b' }, rule, () => t), '1h');
  // First write -0.06M, three gains +0.3M, four losses -0.24M: 0, inside the band, stays on.
  for (let i = 0; i < 4; i++) { t += 120 * MIN; observeUsage({ session: 'ses_b', model: 'm', usage: usage(100000), now: t }, rule); }
  assert.deepEqual(ttlDecision({ 'x-session-id': 'ses_b' }, rule, () => t), { ttl: '1h', reason: 'adaptive-on' });
  // Two more push it under offBelow (-0.12M): off, and it stays off inside the band.
  for (let i = 0; i < 2; i++) { t += 120 * MIN; observeUsage({ session: 'ses_b', model: 'm', usage: usage(100000), now: t }, rule); }
  assert.equal(ttlForRequest({ 'x-session-id': 'ses_b' }, rule, () => t), null);
  t += 30 * MIN; observeUsage({ session: 'ses_b', model: 'm', usage: usage(100000), now: t }, rule);
  assert.equal(ttlForRequest({ 'x-session-id': 'ses_b' }, rule, () => t), null, 'one gain does not flip it back');
});

test('the window forgets old evidence, so a phase change is followed', () => {
  const rule = ruleFile();
  let t = feed(rule, 'ses_b', [120, 120, 120, 120]);
  assert.equal(ttlForRequest({ 'x-session-id': 'ses_b' }, rule, () => t), null);
  t = feed(rule, 'ses_b', [30, 30, 30], { start: t + 23 * 60 * MIN });
  assert.deepEqual(ttlDecision({ 'x-session-id': 'ses_b' }, rule, () => t), { ttl: '1h', reason: 'adaptive-on' });
});

test('a subagent without its own evidence follows its parent', () => {
  const rule = ruleFile();
  const t = feed(rule, 'ses_p', [30, 30, 30]);
  observeUsage({ session: 'ses_c', parent: 'ses_p', model: 'm', usage: usage(50000), now: t }, rule);
  assert.deepEqual(ttlDecision({ 'x-session-id': 'ses_c', 'x-parent-session-id': 'ses_p' }, rule, () => t),
    { ttl: '1h', reason: 'adaptive-parent-on' });
});

test('requests without cache are ignored and models are scored separately', () => {
  const rule = ruleFile();
  let t = T0;
  for (let i = 0; i < 4; i++) {
    observeUsage({ session: 'ses_b', model: 'big', usage: usage(100000), now: t }, rule);
    observeUsage({ session: 'ses_b', model: 'small', usage: { input_tokens: 50, output_tokens: 5 }, now: t + MIN }, rule);
    observeUsage({ session: 'ses_b', model: 'mid', usage: usage(2000), now: t + 2 * MIN }, rule);
    t += 30 * MIN;
  }
  // 'big' scores 3 gains of 100k; 'small' is ignored; 'mid' scores 3 small gains.
  assert.deepEqual(ttlDecision({ 'x-session-id': 'ses_b' }, rule, () => t), { ttl: '1h', reason: 'adaptive-on' });
});

test('replayUsageLog rebuilds state from the ledger window', () => {
  const rule = ruleFile();
  const log = join(dir, 'usage.jsonl'); writeFileSync(log, '');
  const line = (ts, session) => usageLogLine({ account: 'a', model: 'm', sessionKey: { session, ttlReason: session === 'ses_codex' ? null : 'prior-none' }, usage: usage(100000), now: ts });
  appendFileSync(log, line(T0 - 48 * 60 * MIN, 'ses_old') + '\nnot json\n');
  for (let i = 0; i < 4; i++) appendFileSync(log, line(T0 + i * 30 * MIN, 'ses_r') + '\n' + line(T0 + i * 30 * MIN, 'ses_codex') + '\n');
  const now = T0 + 4 * 30 * MIN;
  assert.equal(replayUsageLog(log, rule, now), 4, 'rows without a TTL decision are skipped');
  assert.deepEqual(ttlDecision({ 'x-session-id': 'ses_codex' }, rule, () => now), { ttl: null, reason: 'prior-none' });
  assert.deepEqual(ttlDecision({ 'x-session-id': 'ses_r' }, rule, () => now), { ttl: '1h', reason: 'adaptive-on' });
});

test('the ledger line records the TTL decision', () => {
  const j = JSON.parse(usageLogLine({ sessionKey: { session: 's', ttl: '1h', ttlReason: 'adaptive-on' }, usage: {} }));
  assert.equal(j.ttl, '1h'); assert.equal(j.ttl_reason, 'adaptive-on');
  const k = JSON.parse(usageLogLine({ sessionKey: { session: 's' }, usage: {} }));
  assert.equal(k.ttl, null); assert.equal(k.ttl_reason, null);
});

test('one big 5-60 min gap is not enough to switch on (minMidGaps)', () => {
  const rule = ruleFile();
  const t = feed(rule, 'ses_b', [30, 1, 1, 1, 1], { ctx: 500000 });
  // -0.3M first write, +0.5M once, then four warm repeats: +0.2M, above onAbove, but only one mid gap.
  assert.deepEqual(ttlDecision({ 'x-session-id': 'ses_b' }, rule, () => t), { ttl: null, reason: 'adaptive-off' });
});

test('a session whose window empties forgets its state and returns to the prior', () => {
  const rule = ruleFile();
  const t = feed(rule, 'ses_b', [30, 30, 30]);
  assert.equal(ttlForRequest({ 'x-session-id': 'ses_b' }, rule, () => t), '1h');
  const later = t + 25 * 60 * MIN;
  assert.deepEqual(ttlDecision({ 'x-session-id': 'ses_b' }, rule, () => later), { ttl: null, reason: 'prior-none' });
});

test("a parent's undecided state starts from the parent's own prior, not the child's", () => {
  const rule = ruleFile({ sessions: ['ses_c'] });
  const t = feed(rule, 'ses_p', [30, 30], { ctx: 50000 }); // -30k + 50k + 50k = +70k: inside the band
  assert.deepEqual(ttlDecision({ 'x-session-id': 'ses_c', 'x-parent-session-id': 'ses_p' }, rule, () => t),
    { ttl: null, reason: 'adaptive-parent-off' });
});

test('replay prefers req_ts and does not score a replayed first line', () => {
  const rule = ruleFile({ adaptive: { enabled: true, minEvents: 1, onAbove: 1, offBelow: -1, minMidGaps: 0, windowHours: 24, replay: false } });
  const log = join(dir, 'usage2.jsonl');
  const line = (ts, req) => usageLogLine({ model: 'm', sessionKey: { session: 'ses_q', reqStartMs: req, ttlReason: 'prior-none' }, usage: usage(100000), now: ts });
  // Settle times 4 min apart, but the requests started 10 min apart: a 5-60 min gap.
  writeFileSync(log, line(T0 + 2 * MIN, T0) + '\n' + line(T0 + 6 * MIN, T0 + 10 * MIN) + '\n');
  assert.equal(replayUsageLog(log, rule, T0 + 20 * MIN), 2);
  assert.deepEqual(ttlDecision({ 'x-session-id': 'ses_q' }, rule, () => T0 + 20 * MIN), { ttl: '1h', reason: 'adaptive-on' });
});
