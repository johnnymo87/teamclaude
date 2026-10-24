import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const H = 3600_000;
const OPUS = 'claude-opus-5';

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
    assert.equal(am._inFinalWindow(am.accounts[1], OPUS, Date.now()), false, JSON.stringify(opts));
  }
});

test('final window: boundaries — unknown, past, exactly at window edge, just beyond', () => {
  const am = mk(['a']);
  const a = am.accounts[0];
  const now = Date.now();
  bucket(am, 0, 'unified7d', 0.5, null, now);
  assert.equal(am._inFinalWindow(a, OPUS, now), false, 'unknown reset');
  bucket(am, 0, 'unified7d', 0.5, -0.1, now);
  assert.equal(am._inFinalWindow(a, OPUS, now), false, 'reset in the past');
  bucket(am, 0, 'unified7d', 0.5, 5, now);
  assert.equal(am._inFinalWindow(a, OPUS, now), true, 'exactly 5h');
  bucket(am, 0, 'unified7d', 0.5, 5.001, now);
  assert.equal(am._inFinalWindow(a, OPUS, now), false, 'just beyond');
});

test('final window: 5h guard — unified5h >= 0.90 disqualifies, below qualifies, unknown qualifies', () => {
  const am = mk(['a']);
  const a = am.accounts[0];
  bucket(am, 0, 'unified7d', 0.5, 3);
  a.quota.unified5h = 0.90;
  assert.equal(am._inFinalWindow(a, OPUS, Date.now()), false);
  a.quota.unified5h = 0.89;
  assert.equal(am._inFinalWindow(a, OPUS, Date.now()), true);
  a.quota.unified5h = null;
  assert.equal(am._inFinalWindow(a, OPUS, Date.now()), true);
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
  assert.equal(am._inFinalWindow(am.accounts[1], OPUS, Date.now()), false);
  assert.equal(am.getActiveAccount(null, OPUS).name, 'b');
});
