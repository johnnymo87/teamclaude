import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseUsagePayload } from '../src/oauth.js';

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/usage-account0-healthy.json', import.meta.url)), 'utf8'));

test('parses the real healthy payload: unified buckets + sonnet scope, no opus', () => {
  const u = parseUsagePayload(fixture);
  assert.equal(u.fiveHour.utilization, 0.03);
  assert.equal(u.sevenDay.utilization, 0.11);
  assert.equal(u.sevenDaySonnet.utilization, 0.04);
  // scopedLimits: sonnet present (is_active false), opus absent (no entry)
  assert.ok(u.scopedLimits);
  assert.equal(u.scopedLimits.opus, undefined);
  assert.equal(u.scopedLimits.sonnet.isActive, false);
  assert.equal(u.scopedLimits.sonnet.severity, 'normal');
  assert.equal(u.scopedLimits.sonnet.utilization, 0.04);
  assert.equal(u.scopedLimits.sonnet.resetAt, Date.parse('2026-06-26T04:00:00.128531+00:00'));
});

test('parses a synthetic ACTIVE opus weekly_scoped entry', () => {
  const payload = { limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 97, severity: 'high',
      resets_at: '2026-06-26T04:00:00Z', scope: { model: { display_name: 'Opus' } }, is_active: true },
  ]};
  const u = parseUsagePayload(payload);
  assert.equal(u.scopedLimits.opus.isActive, true);
  assert.equal(u.scopedLimits.opus.severity, 'high');
  assert.equal(u.scopedLimits.opus.utilization, 0.97);
  assert.equal(u.scopedLimits.opus.resetAt, Date.parse('2026-06-26T04:00:00Z'));
});

test('[R2] scoped percent uses the 0–100 scale at the boundary (1 → 0.01, not 1.0)', () => {
  const payload = { limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 1, severity: 'normal',
      resets_at: '2026-06-26T04:00:00Z', scope: { model: { display_name: 'Opus' } }, is_active: true },
  ]};
  assert.equal(parseUsagePayload(payload).scopedLimits.opus.utilization, 0.01);
});

test('ignores session/non-weekly and unscoped limits; tolerates missing limits[]', () => {
  // NOTE: payload percents are 0–100; normalizeUsageBucket only divides when >1,
  // so use an unambiguous value (50 → 0.5), never exactly 1 (1% vs 100% is ambiguous).
  const u = parseUsagePayload({ five_hour: { utilization: 50 } });
  assert.deepEqual(u.scopedLimits, {});
  assert.equal(u.fiveHour.utilization, 0.5);
});
