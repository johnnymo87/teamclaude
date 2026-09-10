import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

const H = 3600_000;
const OPUS = 'claude-opus-5';

function oauth(name, extra = {}) {
  return {
    name,
    type: 'oauth',
    accessToken: 't-' + name,
    refreshToken: 'r',
    expiresAt: Date.now() + 3600_000,
    ...extra,
  };
}

function codex(name, extra = {}) {
  return oauth(name, { provider: 'codex', accountId: 'acct-' + name, ...extra });
}

function bucket(am, index, key, used, hours, base = Date.now()) {
  const q = am.accounts[index].quota;
  q[key] = used;
  q[`${key}Reset`] = hours != null ? base + hours * H : null;
  am.accounts[index].probing = false;
}

// ---------------------------------------------------------------------------
// 1. /status exposure: strategy, margin, orthogonal switches, per-account W + provenance, labeled pressure
// ---------------------------------------------------------------------------

test('/status reports routingStrategy, weeklyBalanceMargin, expiryRouting.enabled, and per-account W value + provenance', () => {
  const am = new AccountManager([
    oauth('a-unified'),
    oauth('a-proxy'),
    oauth('a-median'),
  ], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.12,
    expiryRouting: { enabled: false },
  });

  const now = Date.now();
  // Account 0: unified bucket
  bucket(am, 0, 'unified7d', 0.40, 10, now);
  // Account 1: family buckets only -> family-proxy max
  am.accounts[1].quota.unified7d = null;
  am.accounts[1].quota.unified7dSonnet = 0.70;
  am.accounts[1].quota.unified7dFable = 0.50;
  am.accounts[1].probing = false;
  // Account 2: unprobed -> inherits median of 0.40 and 0.70 = 0.55
  am.accounts[2].quota.unified7d = null;
  am.accounts[2].quota.unified7dSonnet = null;
  am.accounts[2].quota.unified7dFable = null;
  am.accounts[2].probing = false;

  const status = am.getStatus();

  // Top-level status fields
  assert.equal(status.routingStrategy, 'balanced');
  assert.equal(status.weeklyBalanceMargin, 0.12);
  assert.equal(status.expiryRouting.enabled, false);

  // Per-account W value and provenance
  assert.deepEqual(status.accounts[0].W, { value: 0.40, provenance: 'unified' });
  assert.deepEqual(status.accounts[1].W, { value: 0.70, provenance: 'family-proxy' });
  assert.deepEqual(status.accounts[2].W, { value: 0.55, provenance: 'median' });

  // Existing status pressure field kept for backwards compatibility but labeled
  // so a reader cannot mistake it for the ranking actually in use.
  assert.ok(typeof status.accounts[0].pressure === 'number' && status.accounts[0].pressure > 0);
  assert.equal(status.accounts[0].pressureType, 'expiry');
});

// ---------------------------------------------------------------------------
// 2. Counter marginMove: done, blocked_5h, blocked_paused, below_margin
// ---------------------------------------------------------------------------

test('marginMove counter increments done on a successful margin preemption move', () => {
  // Current account has W = 0.80, candidate has W = 0.20 (gap = 0.60 >= margin 0.10).
  // Candidate 5h is healthy and not paused.
  const am = new AccountManager([oauth('curr'), oauth('best')], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
  });

  const now = Date.now();
  bucket(am, 0, 'unified7d', 0.80, 50, now);
  bucket(am, 1, 'unified7d', 0.20, 50, now);
  am.accounts[0].quota.unified5h = 0.10;
  am.accounts[1].quota.unified5h = 0.10;

  assert.equal(am.currentIndex, 0);
  assert.deepEqual(am.marginMove, {
    done: 0,
    blocked_5h: 0,
    blocked_paused: 0,
    below_margin: 0,
  });

  // Real selection triggers margin preemption move to candidate 1
  const picked = am._select(null, OPUS);
  assert.equal(picked.name, 'best');
  assert.equal(am.currentIndex, 1);

  // Exactly 'done' incremented
  assert.deepEqual(am.marginMove, {
    done: 1,
    blocked_5h: 0,
    blocked_paused: 0,
    below_margin: 0,
  });

  // Also exposed on getStatus()
  assert.deepEqual(am.getStatus().marginMove, {
    done: 1,
    blocked_5h: 0,
    blocked_paused: 0,
    below_margin: 0,
  });
});

test('marginMove counter increments blocked_5h when best candidate sits at unified5h >= 0.90', () => {
  // Current account has W = 0.80, candidate has W = 0.20 (gap = 0.60 >= margin 0.10).
  // BUT candidate has unified5h = 0.95 >= 0.90 (the spill guard).
  const am = new AccountManager([oauth('curr'), oauth('best')], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
  });

  const now = Date.now();
  bucket(am, 0, 'unified7d', 0.80, 50, now);
  bucket(am, 1, 'unified7d', 0.20, 50, now);
  am.accounts[0].quota.unified5h = 0.10;
  am.accounts[1].quota.unified5h = 0.95; // 5h wall!

  assert.equal(am.currentIndex, 0);

  // Selection stays on current because margin move was blocked by 5h spill guard
  const picked = am._select(null, OPUS);
  assert.equal(picked.name, 'curr');
  assert.equal(am.currentIndex, 0);

  // Exactly 'blocked_5h' incremented
  assert.deepEqual(am.marginMove, {
    done: 0,
    blocked_5h: 1,
    blocked_paused: 0,
    below_margin: 0,
  });
});

test('marginMove counter increments blocked_paused when best candidate is paused in the future', () => {
  // Current account has W = 0.80, candidate has W = 0.20 (gap = 0.60 >= margin 0.10).
  // Candidate unified5h is healthy, BUT pausedUntil is in the future.
  const am = new AccountManager([oauth('curr'), oauth('best')], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
  });

  const now = Date.now();
  bucket(am, 0, 'unified7d', 0.80, 50, now);
  bucket(am, 1, 'unified7d', 0.20, 50, now);
  am.accounts[0].quota.unified5h = 0.10;
  am.accounts[1].quota.unified5h = 0.10;
  am.accounts[1].pausedUntil = now + 60_000; // paused!

  assert.equal(am.currentIndex, 0);

  // Selection stays on current because margin move was blocked by paused state
  const picked = am._select(null, OPUS);
  assert.equal(picked.name, 'curr');
  assert.equal(am.currentIndex, 0);

  // Exactly 'blocked_paused' incremented
  assert.deepEqual(am.marginMove, {
    done: 0,
    blocked_5h: 0,
    blocked_paused: 1,
    below_margin: 0,
  });
});

test('marginMove counter increments below_margin when W gap is below weeklyBalanceMargin', () => {
  // Current account has W = 0.80, candidate has W = 0.75 (gap = 0.05 < margin 0.10).
  // Candidate 5h is healthy and not paused.
  const am = new AccountManager([oauth('curr'), oauth('best')], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
  });

  const now = Date.now();
  bucket(am, 0, 'unified7d', 0.80, 50, now);
  bucket(am, 1, 'unified7d', 0.75, 50, now);
  am.accounts[0].quota.unified5h = 0.10;
  am.accounts[1].quota.unified5h = 0.10;

  assert.equal(am.currentIndex, 0);

  // Selection stays on current because gap (0.05) is below margin (0.10)
  const picked = am._select(null, OPUS);
  assert.equal(picked.name, 'curr');
  assert.equal(am.currentIndex, 0);

  // Exactly 'below_margin' incremented
  assert.deepEqual(am.marginMove, {
    done: 0,
    blocked_5h: 0,
    blocked_paused: 0,
    below_margin: 1,
  });
});

// ---------------------------------------------------------------------------
// 3. Preview does NOT increment counters (CRITICAL)
// ---------------------------------------------------------------------------

test('previewRouteIndex calls _marginPreemptedBy with count:false and does NOT increment marginMove counters', () => {
  // Setup fleet where margin preemption would fire
  const am = new AccountManager([oauth('curr'), oauth('best')], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
  });

  const now = Date.now();
  bucket(am, 0, 'unified7d', 0.80, 50, now);
  bucket(am, 1, 'unified7d', 0.20, 50, now);
  am.accounts[0].quota.unified5h = 0.10;
  am.accounts[1].quota.unified5h = 0.10;

  // Call previewRouteIndex repeatedly (simulating TUI re-render / polling)
  for (let i = 0; i < 20; i++) {
    const idx = am.previewRouteIndex(OPUS);
    // Preview correctly predicts account 1 would be picked:
    assert.equal(idx, 1);
  }

  // ALL counters must be strictly 0: preview must NOT measure TUI refresh rate
  assert.deepEqual(am.marginMove, {
    done: 0,
    blocked_5h: 0,
    blocked_paused: 0,
    below_margin: 0,
  }, 'previewRouteIndex must not increment any marginMove counter');

  // Also test preview with 5h wall:
  am.accounts[1].quota.unified5h = 0.95;
  for (let i = 0; i < 10; i++) {
    am.previewRouteIndex(OPUS);
  }
  assert.deepEqual(am.marginMove, {
    done: 0,
    blocked_5h: 0,
    blocked_paused: 0,
    below_margin: 0,
  }, 'previewRouteIndex with 5h wall must not increment any marginMove counter');

  // Also test preview with paused candidate:
  am.accounts[1].quota.unified5h = 0.10;
  am.accounts[1].pausedUntil = now + 60_000;
  for (let i = 0; i < 10; i++) {
    am.previewRouteIndex(OPUS);
  }
  assert.deepEqual(am.marginMove, {
    done: 0,
    blocked_5h: 0,
    blocked_paused: 0,
    below_margin: 0,
  }, 'previewRouteIndex with paused candidate must not increment any marginMove counter');

  // Also test preview with gap below margin:
  am.accounts[1].pausedUntil = null;
  am.accounts[1].quota.unified7d = 0.75;
  for (let i = 0; i < 10; i++) {
    am.previewRouteIndex(OPUS);
  }
  assert.deepEqual(am.marginMove, {
    done: 0,
    blocked_5h: 0,
    blocked_paused: 0,
    below_margin: 0,
  }, 'previewRouteIndex below margin must not increment any marginMove counter');

  // In contrast, real selection SHOULD count:
  am.accounts[1].quota.unified7d = 0.20;
  am._select(null, OPUS);
  assert.equal(am.marginMove.done, 1, 'real selection must increment marginMove.done');
});

test('_selectForSession is a real decision and increments marginMove counters', () => {
  const am = new AccountManager([oauth('pinned'), oauth('candidate')], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
    distributeSessions: true,
  });

  const now = Date.now();
  bucket(am, 0, 'unified7d', 0.80, 50, now);
  bucket(am, 1, 'unified7d', 0.20, 50, now);
  am.accounts[0].quota.unified5h = 0.10;
  am.accounts[1].quota.unified5h = 0.10;

  // Pin session to account 0
  am.recordSession('sess-1', 0, OPUS);

  assert.deepEqual(am.marginMove, {
    done: 0,
    blocked_5h: 0,
    blocked_paused: 0,
    below_margin: 0,
  });

  // _selectForSession with session 'sess-1' evaluates margin preemption on the pinned account
  const picked = am._selectForSession('sess-1', null, OPUS);
  // Margin preemption releases the pin and picks candidate
  assert.equal(picked.name, 'candidate');
  assert.equal(am.marginMove.done, 1, '_selectForSession must increment marginMove.done when margin move triggers');
});

// ---------------------------------------------------------------------------
// 4. Per-provider spread metric for alerting
// ---------------------------------------------------------------------------

test('per-provider spread is computed within provider, not across', () => {
  // Construct a two-provider fleet where cross-fleet spread would differ:
  // Anthropic fleet: {0.80, 0.20} -> Anthropic spread = 0.80 - 0.20 = 0.60
  // Codex fleet: {0.08, 0.05} -> Codex spread = 0.08 - 0.05 = 0.03
  // Fleet-wide spread would be 0.80 - 0.05 = 0.75!
  const am = new AccountManager([
    oauth('ant-high'),
    oauth('ant-low'),
    codex('cod-high'),
    codex('cod-low'),
  ], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
  });

  const now = Date.now();
  bucket(am, 0, 'unified7d', 0.80, 50, now);
  bucket(am, 1, 'unified7d', 0.20, 50, now);
  bucket(am, 2, 'unified7d', 0.08, 50, now);
  bucket(am, 3, 'unified7d', 0.05, 50, now);

  const status = am.getStatus();

  assert.ok(status.spread, 'status must expose spread metric');
  assert.equal(status.spread.anthropic, 0.60, 'Anthropic spread must be max(W) - min(W) among Anthropic accounts');
  assert.equal(status.spread.codex, 0.03, 'Codex spread must be max(W) - min(W) among Codex accounts');

  // Verify it did not compute fleet-wide spread:
  assert.notEqual(status.spread.anthropic, 0.75);
  assert.notEqual(status.spread.codex, 0.75);
});

// ---------------------------------------------------------------------------
// 5. Inert under 'expiry' and 'drain' strategies
// ---------------------------------------------------------------------------

test("under 'expiry' and 'drain' strategies, fields are present but inert (no counting)", () => {
  for (const strategy of ['expiry', 'drain']) {
    const am = new AccountManager([
      oauth('a1'),
      oauth('a2'),
    ], 0.98, {
      routingStrategy: strategy,
      weeklyBalanceMargin: 0.10,
      expiryRouting: { enabled: true },
    });

    const now = Date.now();
    bucket(am, 0, 'unified7d', 0.80, 10, now);
    bucket(am, 1, 'unified7d', 0.20, 50, now);

    const status = am.getStatus();
    assert.equal(status.routingStrategy, strategy);
    assert.equal(status.weeklyBalanceMargin, 0.10);
    assert.equal(status.expiryRouting.enabled, true);
    assert.deepEqual(status.marginMove, {
      done: 0,
      blocked_5h: 0,
      blocked_paused: 0,
      below_margin: 0,
    });
    assert.ok(status.spread);
    assert.deepEqual(status.accounts[0].W, { value: 0.80, provenance: 'unified' });
    assert.deepEqual(status.accounts[1].W, { value: 0.20, provenance: 'unified' });

    // Under expiry or drain, run selections:
    am._select(null, OPUS);
    am.previewRouteIndex(OPUS);

    // marginMove counters must remain strictly 0 (inert)
    assert.deepEqual(am.marginMove, {
      done: 0,
      blocked_5h: 0,
      blocked_paused: 0,
      below_margin: 0,
    }, `marginMove must remain inert under strategy ${strategy}`);
  }
});

test('HTTP GET /teamclaude/status exposes routingStrategy, weeklyBalanceMargin, marginMove, spread, and account W', async () => {
  const am = new AccountManager([
    oauth('ant-1'),
    oauth('ant-2'),
  ], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.15,
  });

  const now = Date.now();
  bucket(am, 0, 'unified7d', 0.85, 20, now);
  bucket(am, 1, 'unified7d', 0.25, 40, now);

  const proxy = createProxyServer(am, { proxy: { apiKey: 'test-secret' }, upstream: 'http://127.0.0.1:9' });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const port = proxy.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`, {
      headers: { 'x-api-key': 'test-secret' },
    });
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.equal(data.routingStrategy, 'balanced');
    assert.equal(data.weeklyBalanceMargin, 0.15);
    assert.equal(data.expiryRouting.enabled, false);
    assert.deepEqual(data.marginMove, {
      done: 0,
      blocked_5h: 0,
      blocked_paused: 0,
      below_margin: 0,
    });
    assert.equal(data.spread.anthropic, 0.60);
    assert.deepEqual(data.accounts[0].W, { value: 0.85, provenance: 'unified' });
    assert.deepEqual(data.accounts[1].W, { value: 0.25, provenance: 'unified' });
    assert.equal(data.accounts[0].pressureType, 'expiry');
  } finally {
    await new Promise(resolve => proxy.close(resolve));
  }
});
