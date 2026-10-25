import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager, FINAL_WINDOW_MIN_HEADROOM, RESET_HOLD_MS } from '../src/account-manager.js';

const H = 3600_000;
const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

function bucket(am, index, key, used, hours, base = Date.now()) {
  const q = am.accounts[index].quota;
  q[key] = used;
  q[`${key}Reset`] = hours != null ? base + hours * H : null;
  am.accounts[index].probing = false;
}

function mk(names, opts = {}) {
  return new AccountManager(names.map(n => oauth(n)), 0.98, {
    routingStrategy: 'balanced', weeklyBalanceMargin: 0.10, finalWindowHours: 5, ...opts,
  });
}

test('final window: knob defaults to 0 and validates', () => {
  assert.equal(new AccountManager([oauth('a')], 0.98, { routingStrategy: 'balanced' }).finalWindowHours, 0);
  assert.equal(mk(['a'], { finalWindowHours: 5 }).finalWindowHours, 5);
  for (const bad of [-1, 25, NaN, Infinity, '5', null]) {
    assert.equal(mk(['a'], { finalWindowHours: bad }).finalWindowHours, 0, `bad=${bad}`);
  }
});

test('final window: ranks an account resetting within the window first, over lower utilization', () => {
  const am = mk(['a', 'b']);
  bucket(am, 0, 'unified7d', 0.20, 50);   // a: low W, resets in 50h
  bucket(am, 1, 'unified7d', 0.84, 4);    // b: high W, resets in 4h -> final
  assert.equal(am._pickBestAvailable(null, OPUS).name, 'b');
});

test('final window: off (0) and non-balanced strategies keep current ranking', () => {
  for (const opts of [{ finalWindowHours: 0 }, { routingStrategy: 'expiry', expiryRouting: { enabled: false } }, { routingStrategy: 'drain' }]) {
    const am = mk(['a', 'b'], opts);
    bucket(am, 0, 'unified7d', 0.20, 50);
    bucket(am, 1, 'unified7d', 0.84, 4);
    const ref = new AccountManager([oauth('a'), oauth('b')], 0.98, { weeklyBalanceMargin: 0.10, routingStrategy: 'balanced', ...opts, finalWindowHours: 0 });
    bucket(ref, 0, 'unified7d', 0.20, 50);
    bucket(ref, 1, 'unified7d', 0.84, 4);
    assert.equal(am._pickBestAvailable(null, OPUS).name, ref._pickBestAvailable(null, OPUS).name, JSON.stringify(opts));
    assert.equal(am._inFinalWindow(am.accounts[1]), false, JSON.stringify(opts));
  }
});

test('final window: boundaries — unknown, past, exactly at window edge, just beyond', () => {
  const am = mk(['a']);
  const a = am.accounts[0];
  const now = Date.now();
  bucket(am, 0, 'unified7d', 0.5, null, now);
  assert.equal(am._inFinalWindow(a, { now }), false, 'unknown reset');
  bucket(am, 0, 'unified7d', 0.5, -0.1, now);
  assert.equal(am._inFinalWindow(a, { now }), false, 'reset in the past');
  bucket(am, 0, 'unified7d', 0.5, 5, now);
  assert.equal(am._inFinalWindow(a, { now }), true, 'exactly 5h');
  bucket(am, 0, 'unified7d', 0.5, 5.001, now);
  assert.equal(am._inFinalWindow(a, { now }), false, 'just beyond');
});

test('final window: 5h guard — unified5h >= 0.90 disqualifies, below qualifies, unknown qualifies', () => {
  const am = mk(['a']);
  const a = am.accounts[0];
  bucket(am, 0, 'unified7d', 0.5, 3);
  a.quota.unified5h = 0.90;
  assert.equal(am._inFinalWindow(a), false);
  a.quota.unified5h = 0.89;
  assert.equal(am._inFinalWindow(a), true);
  a.quota.unified5h = null;
  assert.equal(am._inFinalWindow(a), true);
});

test('final window: sooner reset wins between two final-window accounts', () => {
  const am = mk(['a', 'b', 'c']);
  bucket(am, 0, 'unified7d', 0.10, 50);
  bucket(am, 1, 'unified7d', 0.50, 4);
  bucket(am, 2, 'unified7d', 0.90, 2);
  assert.equal(am._pickBestAvailable(null, OPUS).name, 'c');
});

test('final window: account at/above the switch threshold is never chosen', () => {
  const am = mk(['a', 'b']);
  bucket(am, 0, 'unified7d', 0.80, 50);
  bucket(am, 1, 'unified7d', 0.98, 2);
  assert.equal(am._pickBestAvailable(null, OPUS).name, 'a');
});

test('final window: moves the cursor despite the margin, counts final_window, then stays', () => {
  const am = mk(['a', 'b']);
  am.currentIndex = 0;
  bucket(am, 0, 'unified7d', 0.81, 50);  // current
  bucket(am, 1, 'unified7d', 0.84, 4);   // higher W, final -> margin alone would never move
  const before = { ...am.marginMove };
  assert.equal(am.getActiveAccount(null, OPUS).name, 'b');
  assert.equal(am.currentIndex, 1);
  assert.equal(am.marginMove.final_window, before.final_window + 1);
  assert.equal(am.marginMove.done, before.done, 'not counted as an ordinary margin move');
  // Next request: b is its own best, stays.
  assert.equal(am.getActiveAccount(null, OPUS).name, 'b');
  assert.equal(am.marginMove.final_window, before.final_window + 1);
});

test('final window: no move onto a final-window account at unified5h >= 0.90', () => {
  const am = mk(['a', 'b']);
  am.currentIndex = 0;
  bucket(am, 0, 'unified7d', 0.81, 50);
  bucket(am, 1, 'unified7d', 0.84, 4);
  am.accounts[1].quota.unified5h = 0.95;
  assert.equal(am.getActiveAccount(null, OPUS).name, 'a');
});

test('final window: no move onto a paused final-window account', () => {
  const am = mk(['a', 'b']);
  am.currentIndex = 0;
  bucket(am, 0, 'unified7d', 0.81, 50);
  bucket(am, 1, 'unified7d', 0.84, 4);
  am.accounts[1].pausedUntil = Date.now() + 60_000;
  assert.equal(am.getActiveAccount(null, OPUS).name, 'a');
});

test('final window: after the reset the account is ordinary again (no bounce)', () => {
  const am = mk(['a', 'b']);
  am.currentIndex = 1;
  bucket(am, 0, 'unified7d', 0.81, 50);
  bucket(am, 1, 'unified7d', 0.02, 168); // b just reset: low W, a week away
  assert.equal(am._inFinalWindow(am.accounts[1]), false);
  assert.equal(am.getActiveAccount(null, OPUS).name, 'b');
});

test('final window: judged on shared weekly window — Fable-only near reset does NOT qualify', () => {
  const am = mk(['a', 'b']);
  bucket(am, 0, 'unified7d', 0.20, 50);
  bucket(am, 1, 'unified7d', 0.50, 50);
  bucket(am, 1, 'unified7dFable', 0.70, 3);
  assert.equal(am._inFinalWindow(am.accounts[1]), false, 'Fable-only near reset must not qualify for final window');
  assert.equal(am._pickBestAvailable(null, FABLE).name, 'a');
  assert.equal(am._pickBestAvailable(null, OPUS).name, 'a');
});

test('final window: shared-weekly final account wins for both Opus and Fable requests', () => {
  const am = mk(['a', 'b']);
  bucket(am, 0, 'unified7d', 0.84, 4);  // a: shared weekly in 4h -> final
  bucket(am, 0, 'unified7dFable', 0.10, 100);
  bucket(am, 1, 'unified7d', 0.20, 50); // b: shared weekly in 50h
  bucket(am, 1, 'unified7dFable', 0.05, 50);
  assert.equal(am._inFinalWindow(am.accounts[0]), true, 'shared weekly near reset qualifies');
  assert.equal(am._pickBestAvailable(null, OPUS).name, 'a');
  assert.equal(am._pickBestAvailable(null, FABLE).name, 'a');
});

test('final window: regression — alternating Opus/Fable requests keep cursor on shared-weekly final account (no ping-pong)', () => {
  const am = mk(['a', 'b', 'e']);
  const b = am.accounts[1];
  // A: shared weekly resets in 4h, Fable reset in 100h
  bucket(am, 0, 'unified7d', 0.84, 4);
  bucket(am, 0, 'unified7dFable', 0.10, 100);
  // B: resets in 60h
  bucket(am, 1, 'unified7d', 0.40, 60);
  bucket(am, 1, 'unified7dFable', 0.05, 60);
  // E: resets in 100h
  bucket(am, 2, 'unified7d', 0.22, 100);
  bucket(am, 2, 'unified7dFable', 0.0, 100);

  am._setCurrent(b);
  assert.equal(am.currentIndex, 1);

  const initialMoves = am.marginMove.final_window;
  const seq = [OPUS, FABLE, OPUS, FABLE, OPUS];
  for (const m of seq) {
    const picked = am.getActiveAccount(new Set(), m);
    assert.equal(picked.name, 'a', `request for ${m} should stay on account 'a'`);
    assert.equal(am.currentIndex, 0, `cursor must stay on 'a' (index 0) for ${m}`);
  }
  // final_window move counter increments exactly once on initial transition from b to a
  assert.equal(am.marginMove.final_window, initialMoves + 1);
  assert.equal(am.marginMove.done, 0);
});

test('final window: no bounce at weekly reset when current account W is imputed (median or empty)', async () => {
  for (const fw of [5, 0]) {
    const am = new AccountManager(['a', 'b', 'c', 'd', 'e'].map(n => oauth(n)), 0.98, {
      routingStrategy: 'balanced', weeklyBalanceMargin: 0.10, finalWindowHours: fw,
    });
    for (const acct of am.accounts) acct.probing = false;
    const a = am.accounts[0];
    bucket(am, 0, 'unified7d', 0.90, 0.000005);
    bucket(am, 1, 'unified7d', 0.88, 85);
    bucket(am, 2, 'unified7d', 0.89, 30);
    bucket(am, 3, 'unified7d', 0.26, 144);
    bucket(am, 4, 'unified7d', 0.22, 125);

    am._setCurrent(a);
    assert.equal(am.currentIndex, 0);

    // Simulate weekly reset expiration via _clearExpiredQuotas
    a.quota.unified7dReset = Date.now() - 1000;
    am._clearExpiredQuotas(a);

    const r1 = am.getActiveAccount(new Set(), OPUS).name;
    if (fw > 0) {
      assert.equal(r1, 'a', 'with finalWindowHours > 0, cursor must hold on a through reset');
      assert.equal(am.marginMove.held_imputed, 1, 'held_imputed must increment when holding on imputed W');

      // Next probe: a reads ~0 with fresh reset
      bucket(am, 0, 'unified7d', 0.01, 168);
      const r2 = am.getActiveAccount(new Set(), OPUS).name;
      assert.equal(r2, 'a', 'after probe, cursor stays on a');
    } else {
      assert.equal(r1, 'e', 'with finalWindowHours === 0, old behaviour moves to e');
      // Next probe: a reads ~0, then cursor moves back to a
      bucket(am, 0, 'unified7d', 0.01, 168);
      const r2 = am.getActiveAccount(new Set(), OPUS).name;
      assert.equal(r2, 'a', 'after probe, cursor moves back to a');
    }
  }
});

test('final window: two final-window accounts with identical reset timestamps fall through to utilization', () => {
  const base = Date.now();
  const am = mk(['a', 'b']);
  bucket(am, 0, 'unified7d', 0.30, 3, base);
  bucket(am, 1, 'unified7d', 0.70, 3, base);
  assert.equal(am._pickBestAvailable(null, OPUS).name, 'a');
});

test('final window (session mode): heldOff is -1 for a final-window account even when far above min W', () => {
  const am = mk(['a', 'b'], { distributeSessions: true });
  bucket(am, 0, 'unified7d', 0.10, 50);
  bucket(am, 1, 'unified7d', 0.84, 4);
  const spent = am._belowBandFloor(am.accounts, OPUS, Date.now());
  assert.deepEqual(spent, [0, -1]);
});

test('final window (session mode): even picker prefers the final-window account over a less-loaded one', () => {
  const am = mk(['a', 'b'], { distributeSessions: true });
  bucket(am, 0, 'unified7d', 0.10, 50);
  bucket(am, 1, 'unified7d', 0.84, 4);
  assert.equal(am._pickLeastLoadedEven(null, OPUS).name, 'b');
});

test('final window (session mode): knob off keeps the old held-off values', () => {
  const am = mk(['a', 'b'], { distributeSessions: true, finalWindowHours: 0 });
  bucket(am, 0, 'unified7d', 0.10, 50);
  bucket(am, 1, 'unified7d', 0.84, 4);
  assert.deepEqual(am._belowBandFloor(am.accounts, OPUS, Date.now()), [0, 1]);
});

test('final window (session mode): adaptive picker prefers the final-window account', () => {
  const am = mk(['a', 'b'], { distributeSessions: 'adaptive' });
  bucket(am, 0, 'unified7d', 0.10, 50);
  bucket(am, 1, 'unified7d', 0.84, 4);
  assert.equal(am._pickAdaptive(null, OPUS).name, 'b');
});

test('final window (session mode): two final-window accounts break tie by load terms', () => {
  const am = mk(['a', 'b'], { distributeSessions: true });
  bucket(am, 0, 'unified7d', 0.50, 3);
  bucket(am, 1, 'unified7d', 0.60, 3);
  am.recordSession('s-1', 0, OPUS);
  am.recordSession('s-2', 0, OPUS);
  assert.equal(am._pickLeastLoadedEven(null, OPUS).name, 'b');
});

test('final window: getStatus reports top-level finalWindowHours and per-account finalWindow', () => {
  const am = mk(['a', 'b'], { finalWindowHours: 5 });
  bucket(am, 0, 'unified7d', 0.20, 50); // not final
  bucket(am, 1, 'unified7d', 0.84, 4);  // in final window
  const status = am.getStatus();
  assert.equal(status.finalWindowHours, 5);
  assert.equal(status.accounts[0].finalWindow, false);
  assert.equal(status.accounts[1].finalWindow, true);

  // An unavailable account is never marked finalWindow in status (e.g. disabled or at threshold)
  am.accounts[1].disabled = true;
  assert.equal(am.getStatus().accounts[1].finalWindow, false);
  am.accounts[1].disabled = false;
  am.accounts[1].quota.unified7d = 0.99; // threshold is 0.98
  assert.equal(am.getStatus().accounts[1].finalWindow, false);
});

test('final window: getStatus marginMove includes final_window counter', () => {
  const am = mk(['a', 'b'], { finalWindowHours: 5 });
  am.currentIndex = 0;
  bucket(am, 0, 'unified7d', 0.81, 50);
  bucket(am, 1, 'unified7d', 0.84, 4);
  am.getActiveAccount(null, OPUS);
  const status = am.getStatus();
  assert.equal(typeof status.marginMove.final_window, 'number');
  assert.equal(status.marginMove.final_window, 1);
});

test('final window: entry headroom constant is exported with value 0.03', () => {
  assert.equal(FINAL_WINDOW_MIN_HEADROOM, 0.03);
});

test('final window: entry headroom — 0.975 weekly not entered, 0.96 entered', () => {
  // Switch threshold 1.0 -> headroom bound is 1.0 - 0.03 = 0.97
  const am = new AccountManager([oauth('a'), oauth('b')], 1.0, {
    routingStrategy: 'balanced', weeklyBalanceMargin: 0.10, finalWindowHours: 5,
  });
  bucket(am, 0, 'unified7d', 0.40, 50);
  bucket(am, 1, 'unified7d', 0.975, 4);
  am.currentIndex = 0;

  // 0.975 > 0.97 -> entry headroom check fails, b does NOT qualify for final window
  assert.equal(am._inFinalWindow(am.accounts[1]), false, '0.975 weekly exceeds threshold - 0.03 headroom');
  assert.equal(am.getActiveAccount(null, OPUS).name, 'a');

  // 0.96 <= 0.97 -> qualifies and enters final window
  bucket(am, 1, 'unified7d', 0.96, 4);
  assert.equal(am._inFinalWindow(am.accounts[1]), true, '0.96 weekly qualifies with >= 0.03 headroom');
  assert.equal(am.getActiveAccount(null, OPUS).name, 'b');
});

test('final window: entry 5h guard — non-current at 5h 0.89 entered, at 0.90 not entered', () => {
  const am = mk(['a', 'b']);
  bucket(am, 0, 'unified7d', 0.40, 50);
  bucket(am, 1, 'unified7d', 0.84, 4);
  am.currentIndex = 0;

  // 5h at 0.90 -> fails entry guard
  am.accounts[1].quota.unified5h = 0.90;
  assert.equal(am._inFinalWindow(am.accounts[1]), false, '5h 0.90 fails entry guard');
  assert.equal(am.getActiveAccount(null, OPUS).name, 'a');

  // 5h at 0.89 -> passes entry guard
  am.accounts[1].quota.unified5h = 0.89;
  assert.equal(am._inFinalWindow(am.accounts[1]), true, '5h 0.89 passes entry guard');
  assert.equal(am.getActiveAccount(null, OPUS).name, 'b');
});

test('final window: hysteresis — current final account at 5h 0.93 stays final and cursor does not move', () => {
  const am = mk(['a', 'b']);
  bucket(am, 0, 'unified7d', 0.20, 50);
  bucket(am, 1, 'unified7d', 0.84, 4);
  am._setCurrent(am.accounts[1]);
  assert.equal(am.currentIndex, 1);

  // b is current; its 5h rises to 0.93 (above MARGIN_5H_GUARD 0.90, but below switch threshold 0.98)
  am.accounts[1].quota.unified5h = 0.93;

  // Entry guards do not apply to current account: stays final
  assert.equal(am._inFinalWindow(am.accounts[1], { current: am.accounts[1] }), true);
  const picked = am.getActiveAccount(null, OPUS);
  assert.equal(picked.name, 'b', 'cursor must stay on current final account');
  assert.equal(am.currentIndex, 1);
});

test('final window: current reaching the switch threshold leaves via the normal threshold switch', () => {
  const am = mk(['a', 'b']);
  bucket(am, 0, 'unified7d', 0.20, 50);
  bucket(am, 1, 'unified7d', 0.84, 4);
  am._setCurrent(am.accounts[1]);
  assert.equal(am.currentIndex, 1);

  // b reaches 5h switch threshold (0.98)
  am.accounts[1].quota.unified5h = 0.98;
  assert.equal(am.getActiveAccount(null, OPUS).name, 'a', 'reaches 5h threshold -> switches to a');

  // Reset b's 5h, now b reaches weekly switch threshold (0.98)
  am._setCurrent(am.accounts[1]);
  am.accounts[1].quota.unified5h = 0.50;
  am.accounts[1].quota.unified7d = 0.98;
  assert.equal(am.getActiveAccount(null, OPUS).name, 'a', 'reaches weekly threshold -> switches to a');
});

test('final window: eligibility reports outranked by final-window account', () => {
  const am = mk(['a', 'b'], { finalWindowHours: 5 });
  bucket(am, 0, 'unified7d', 0.81, 50); // a: W = 0.81
  bucket(am, 1, 'unified7d', 0.84, 4);  // b: W = 0.84, resets in 4h -> in final window
  am.currentIndex = 0;

  const elA = am.eligibility(0);
  assert.equal(elA.eligible, false);
  assert.equal(elA.reason, 'outranked by final-window account "b"');

  // b itself is eligible
  const elB = am.eligibility(1);
  assert.equal(elB.eligible, true);

  // With finalWindow off (0), b has higher W so does NOT outrank a
  const amOff = mk(['a', 'b'], { finalWindowHours: 0 });
  bucket(amOff, 0, 'unified7d', 0.81, 50);
  bucket(amOff, 1, 'unified7d', 0.84, 4);
  assert.equal(amOff.eligibility(0).eligible, true);

  // When an account outranks on ordinary weekly balance (not final window):
  bucket(amOff, 1, 'unified7d', 0.20, 50); // b lower W by > margin 0.10
  assert.equal(amOff.eligibility(0).eligible, false);
  assert.equal(amOff.eligibility(0).reason, 'outranked on weekly balance by "b"');
});

test('final window: RESET_HOLD_MS is exported and equals 15 minutes', () => {
  assert.equal(RESET_HOLD_MS, 15 * 60_000);
});

test('final window: _clearExpiredQuotas records account.weeklyClearedAt = now on weekly quota reset', () => {
  const am = mk(['a']);
  const a = am.accounts[0];
  const now = 1_700_000_000_000;
  a.quota.unified7d = 0.90;
  a.quota.unified7dReset = now - 1000;
  assert.equal(a.weeklyClearedAt, undefined);
  am._clearExpiredQuotas(a);
  assert.equal(typeof a.weeklyClearedAt, 'number');
  assert.ok(Math.abs(a.weeklyClearedAt - Date.now()) < 5000);
});

test('final window: held_imputed bounds hold in time and skips accounts without reset clear', () => {
  // 5 accounts: a (current, high W), b..e with lower W
  const setup = (weeklyClearedAt = null) => {
    const am = new AccountManager(['a', 'b', 'c', 'd', 'e'].map(n => oauth(n)), 0.98, {
      routingStrategy: 'balanced', weeklyBalanceMargin: 0.10, finalWindowHours: 5,
    });
    for (const acct of am.accounts) acct.probing = false;
    const a = am.accounts[0];
    bucket(am, 0, 'unified7d', null, null); // a has imputed W (empty/median)
    bucket(am, 1, 'unified7d', 0.88, 85);
    bucket(am, 2, 'unified7d', 0.89, 30);
    bucket(am, 3, 'unified7d', 0.26, 144);
    bucket(am, 4, 'unified7d', 0.22, 125);
    am._setCurrent(a);
    if (weeklyClearedAt != null) a.weeklyClearedAt = weeklyClearedAt;
    return am;
  };

  const now = Date.now();

  // 1. Inside RESET_HOLD_MS bound (e.g. cleared 2 minutes ago): hold cursor on a
  const amInside = setup(now - 2 * 60_000);
  assert.equal(amInside.getActiveAccount(new Set(), OPUS).name, 'a', 'inside RESET_HOLD_MS: holds on a');
  assert.equal(amInside.marginMove.held_imputed, 1);

  // 2. After RESET_HOLD_MS bound (e.g. cleared 16 minutes ago): cursor margin-moves to e
  const amAfter = setup(now - 16 * 60_000);
  assert.equal(amAfter.getActiveAccount(new Set(), OPUS).name, 'e', 'after RESET_HOLD_MS: cursor moves to e');
  assert.equal(amAfter.marginMove.held_imputed, 0);

  // 3. Never had a reset clear (weeklyClearedAt is null/undefined): cursor margin-moves to e
  const amNever = setup(null);
  assert.equal(amNever.getActiveAccount(new Set(), OPUS).name, 'e', 'never cleared: cursor moves to e');
  assert.equal(amNever.marginMove.held_imputed, 0);
});

test('final window: _inFinalWindow takes { current, now } options object without positional overloads', () => {
  const am = mk(['a', 'b']);
  const now = Date.now();
  bucket(am, 0, 'unified7d', 0.84, 4, now);
  const a = am.accounts[0];

  // Default options
  assert.equal(am._inFinalWindow(a), true);

  // Passing now in options
  assert.equal(am._inFinalWindow(a, { now: now + 5 * H }), false);
  assert.equal(am._inFinalWindow(a, { now }), true);

  // Passing current in options
  a.quota.unified5h = 0.93; // Above 0.90 entry guard
  // If not current, fails 5h guard:
  assert.equal(am._inFinalWindow(a, { current: null }), false);
  // If current, hysteresis applies and passes:
  assert.equal(am._inFinalWindow(a, { current: a }), true);
});

test('final window: multi-provider current resolution for getStatus and _belowBandFloor', () => {
  const codex = (name) => oauth(name, { provider: 'codex', accountId: 'acct-' + name });
  const am = new AccountManager([
    oauth('ant-0'),
    codex('cod-1'),
    codex('cod-2'),
  ], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
    finalWindowHours: 5,
  });

  const now = Date.now();
  // ant-0 is Anthropic cursor (index 0)
  bucket(am, 0, 'unified7d', 0.50, 50, now);
  am.currentIndex = 0;

  // cod-1 is Codex cursor (index 1), with 5h = 0.93 (above 0.90 entry guard, below 0.98 threshold)
  // and weekly resetting in 3h
  bucket(am, 1, 'unified7d', 0.84, 3, now);
  am.accounts[1].quota.unified5h = 0.93;
  // cod-2 has weekly resetting in 50h
  bucket(am, 2, 'unified7d', 0.40, 50, now);

  // Set Codex provider cursor to cod-1
  am.providerCursors.set('codex', 1);

  // In getStatus, cod-1 should be recognized as current Codex cursor (hysteresis applies) -> finalWindow: true
  const status = am.getStatus();
  assert.equal(status.accounts[1].finalWindow, true, 'cod-1 is current for codex so hysteresis keeps finalWindow true');
  assert.equal(status.accounts[2].finalWindow, false);

  // In _belowBandFloor, cod-1 should receive -1
  const floorScores = am._belowBandFloor([am.accounts[1], am.accounts[2]], null, now);
  assert.equal(floorScores[0], -1, 'current codex account in final window gets -1 score');
  assert.equal(floorScores[1], 0);
});


