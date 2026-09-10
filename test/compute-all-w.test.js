import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

function codex(name, extra = {}) {
  return oauth(name, { provider: 'codex', accountId: 'acct-' + name, ...extra });
}

test('provenance for each of the four cases: unified, family-proxy, median, empty', () => {
  const am = new AccountManager([
    oauth('a-unified'),
    oauth('a-proxy'),
    oauth('a-median'),
  ], 0.98);

  am.accounts[0].quota.unified7d = 0.45;

  am.accounts[1].quota.unified7d = null;
  am.accounts[1].quota.unified7dSonnet = 0.60;
  am.accounts[1].quota.unified7dFable = 0.30;

  am.accounts[2].quota.unified7d = null;
  am.accounts[2].quota.unified7dSonnet = null;
  am.accounts[2].quota.unified7dFable = null;

  const w = am._computeAllW();
  assert.equal(w.length, 3);
  assert.deepEqual(w[0], { value: 0.45, provenance: 'unified' });
  assert.deepEqual(w[1], { value: 0.60, provenance: 'family-proxy' });
  // median of [0.45, 0.60] is (0.45 + 0.60) / 2 = 0.525
  assert.deepEqual(w[2], { value: 0.525, provenance: 'median' });

  // And empty provenance in an unresolved fleet:
  const amEmpty = new AccountManager([oauth('e1'), oauth('e2')], 0.98);
  const wEmpty = amEmpty._computeAllW();
  assert.deepEqual(wEmpty[0], { value: 0, provenance: 'empty' });
  assert.deepEqual(wEmpty[1], { value: 0, provenance: 'empty' });
});

test('median computation with odd count of resolved values takes the exact middle element', () => {
  const am = new AccountManager([
    oauth('a1'),
    oauth('a2'),
    oauth('a3'),
    oauth('unresolved'),
  ], 0.98);

  am.accounts[0].quota.unified7d = 0.80;
  am.accounts[1].quota.unified7d = 0.10;
  am.accounts[2].quota.unified7d = 0.40;
  // Unresolved
  am.accounts[3].quota.unified7d = null;

  const w = am._computeAllW();
  // Sorted: [0.10, 0.40, 0.80], middle is 0.40
  assert.deepEqual(w[3], { value: 0.40, provenance: 'median' });
});

test('median computation with even count of resolved values takes the mean of the two middle elements', () => {
  const am = new AccountManager([
    oauth('a1'),
    oauth('a2'),
    oauth('a3'),
    oauth('a4'),
    oauth('unresolved'),
  ], 0.98);

  am.accounts[0].quota.unified7d = 0.90;
  am.accounts[1].quota.unified7d = 0.10;
  am.accounts[2].quota.unified7d = 0.50;
  am.accounts[3].quota.unified7d = 0.30;
  // Unresolved
  am.accounts[4].quota.unified7d = null;

  const w = am._computeAllW();
  // Sorted: [0.10, 0.30, 0.50, 0.90], middle two are 0.30 and 0.50 -> mean = 0.40
  assert.deepEqual(w[4], { value: 0.40, provenance: 'median' });
});

test('per-provider partitioning: one provider values do NOT affect another provider median', () => {
  // Scenario from design doc Q1:
  // Anthropic fleet: {0.64, 0.43, 0.39} resolved, plus an unprobed account.
  // Codex fleet: {0.05, 0.08} resolved.
  // Fleet-wide median would be: sorted [0.05, 0.08, 0.39, 0.43, 0.64] -> median = 0.39.
  // Per-provider Anthropic median: sorted [0.39, 0.43, 0.64] -> median = 0.43.
  const am = new AccountManager([
    oauth('ant-1'),
    oauth('ant-2'),
    oauth('ant-3'),
    oauth('ant-unprobed'),
    codex('codex-1'),
    codex('codex-2'),
    codex('codex-unprobed'),
  ], 0.98);

  am.accounts[0].quota.unified7d = 0.64;
  am.accounts[1].quota.unified7d = 0.43;
  am.accounts[2].quota.unified7d = 0.39;
  am.accounts[3].quota.unified7d = null;

  am.accounts[4].quota.unified7d = 0.05;
  am.accounts[5].quota.unified7d = 0.08;
  am.accounts[6].quota.unified7d = null;

  const w = am._computeAllW();

  // Anthropic unprobed must get Anthropic median (0.43), NOT fleet median (0.39)
  assert.deepEqual(w[3], { value: 0.43, provenance: 'median' });

  // Codex unprobed must get Codex median ((0.05 + 0.08) / 2 = 0.065), NOT fleet median (0.39)
  assert.deepEqual(w[6], { value: 0.065, provenance: 'median' });
});

test('unresolved provider group gets all 0/empty while sibling provider group resolves normally', () => {
  const am = new AccountManager([
    oauth('ant-1'),
    oauth('ant-2'),
    codex('codex-1'),
    codex('codex-2'),
  ], 0.98);

  // Anthropic has nothing resolved
  am.accounts[0].quota.unified7d = null;
  am.accounts[1].quota.unified7d = null;

  // Codex has resolved values
  am.accounts[2].quota.unified7d = 0.50;
  am.accounts[3].quota.unified7d = null;

  const w = am._computeAllW();

  // Anthropic accounts are empty
  assert.deepEqual(w[0], { value: 0, provenance: 'empty' });
  assert.deepEqual(w[1], { value: 0, provenance: 'empty' });

  // Codex accounts resolve independently
  assert.deepEqual(w[2], { value: 0.50, provenance: 'unified' });
  assert.deepEqual(w[3], { value: 0.50, provenance: 'median' });
});

test('W is model-independent by construction: _computeAllW takes no arguments and does not consult model context', () => {
  const am = new AccountManager([
    oauth('a1'),
    oauth('a2'),
  ], 0.98);

  // Setup account with family-scoped buckets that differ from unified7d
  am.accounts[0].quota.unified7d = 0.30;
  am.accounts[0].quota.unified7dSonnet = 0.85;
  am.accounts[0].quota.unified7dFable = 0.15;

  am.accounts[1].quota.unified7d = null;
  am.accounts[1].quota.unified7dSonnet = 0.90;
  am.accounts[1].quota.unified7dFable = 0.20;

  // 1. Method signature check: takes 0 formal parameters
  assert.equal(am._computeAllW.length, 0, '_computeAllW must take 0 parameters');

  // 2. Call with no arguments
  const baseline = am._computeAllW();

  // 3. Spurious arguments must have no effect
  const withOpus = am._computeAllW('claude-opus-5');
  const withSonnet = am._computeAllW('claude-sonnet-4');
  const withFable = am._computeAllW('claude-fable-5');

  assert.deepEqual(withOpus, baseline);
  assert.deepEqual(withSonnet, baseline);
  assert.deepEqual(withFable, baseline);

  // Notice a1 has unified7d = 0.30, so its W is 0.30 (unified), NOT sonnet's 0.85 or fable's 0.15
  assert.deepEqual(baseline[0], { value: 0.30, provenance: 'unified' });
  // a2 has unified7d = null, so family proxy takes max(0.90, 0.20) = 0.90 (family-proxy), NOT model-dependent
  assert.deepEqual(baseline[1], { value: 0.90, provenance: 'family-proxy' });
});
