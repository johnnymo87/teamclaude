import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsageSeatFirst } from '../src/config.js';
import { AccountManager } from '../src/account-manager.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

test('normalizeUsageSeatFirst: accepts only boolean true, defaults to false', () => {
  assert.equal(normalizeUsageSeatFirst(true), true);
  assert.equal(normalizeUsageSeatFirst(false), false);
  assert.equal(normalizeUsageSeatFirst(undefined), false);
  assert.equal(normalizeUsageSeatFirst(null), false);
  assert.equal(normalizeUsageSeatFirst('true'), false);
  assert.equal(normalizeUsageSeatFirst(1), false);
  assert.equal(normalizeUsageSeatFirst(0), false);
  assert.equal(normalizeUsageSeatFirst({}), false);
  assert.equal(normalizeUsageSeatFirst([]), false);
});

test('AccountManager: usageSeatFirst defaults to false and normalizes', () => {
  assert.equal(new AccountManager([oauth('a')]).usageSeatFirst, false);
  assert.equal(new AccountManager([oauth('a')], 0.98, { usageSeatFirst: true }).usageSeatFirst, true);
  for (const bad of [false, 'true', 1, 0, null, undefined, {}, []]) {
    assert.equal(new AccountManager([oauth('a')], 0.98, { usageSeatFirst: bad }).usageSeatFirst, false, `bad=${bad}`);
  }
});

test('AccountManager: getStatus reports usageSeatFirst and marginMove.seat_first counter', () => {
  const am = new AccountManager([oauth('a')], 0.98, { usageSeatFirst: true });
  const status = am.getStatus();
  assert.equal(status.usageSeatFirst, true);
  assert.equal(typeof status.marginMove.seat_first, 'number');
  assert.equal(status.marginMove.seat_first, 0);
  assert.equal(am.marginMove.seat_first, 0);
});

const H = 3600_000;
const OPUS = 'claude-opus-5';
const ENTERPRISE = { organizationType: 'claude_enterprise', rateLimitTier: 'default_claude_zero', seatTier: 'enterprise_usage_based' };

function spend(usedMinor = 0, extra = {}) {
  return { spend: { enabled: true, usedMinor, limitMinor: null, currency: 'USD', exponent: 2, userDisabled: false, disabledReason: null, ...extra } };
}

function bucket(am, index, key, used, hours, base = Date.now()) {
  const q = am.accounts[index].quota;
  q[key] = used;
  q[`${key}Reset`] = hours != null ? base + hours * H : null;
  am.accounts[index].probing = false;
}

test('behavior 1: flag off: seat ranks as before (regression)', () => {
  const am = new AccountManager([
    oauth('sub', { priority: 0 }),
    oauth('seat', { ...ENTERPRISE, priority: 0, maxDailySpend: 100 }),
    oauth('sub2', { priority: 0 }),
  ], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
    usageSeatFirst: false,
  });
  am.applyUsageData(1, spend(0));
  bucket(am, 0, 'unified7d', 0.20, 50);
  bucket(am, 2, 'unified7d', 0.40, 50);

  // W for sub is 0.20, W for seat is median (0.30), W for sub2 is 0.40.
  // Flag off: sub (0.20) beats seat (0.30).
  assert.equal(am._pickBestAvailable(null, OPUS).name, 'sub');
  assert.equal(am._select(null, OPUS).name, 'sub');
  assert.equal(am.currentIndex, 0);
  assert.equal(am.marginMove.seat_first, 0);
});

test('behavior 2: flag on, no final-window account: seat is picked over lower W and cursor moves to seat bypassing margin', () => {
  const am = new AccountManager([
    oauth('sub', { priority: 0 }),
    oauth('seat', { ...ENTERPRISE, priority: 0, maxDailySpend: 100 }),
    oauth('sub2', { priority: 0 }),
  ], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
    usageSeatFirst: true,
  });
  am.applyUsageData(1, spend(0));
  bucket(am, 0, 'unified7d', 0.20, 50);
  bucket(am, 2, 'unified7d', 0.40, 50);

  // Best pick should be 'seat' even though sub has lower W (0.20 < 0.30).
  assert.equal(am._pickBestAvailable(null, OPUS).name, 'seat');

  // Starting on sub (index 0): W gap (0.20 vs 0.30) is not >= 0.10 in seat's favor,
  // but seatMove bypasses the margin check.
  assert.equal(am.currentIndex, 0);
  const picked = am._select(null, OPUS);
  assert.equal(picked.name, 'seat');
  assert.equal(am.currentIndex, 1);
  assert.equal(am.marginMove.seat_first, 1);

  // Next select stays on seat
  const pickedAgain = am._select(null, OPUS);
  assert.equal(pickedAgain.name, 'seat');
  assert.equal(am.currentIndex, 1);
  assert.equal(am.marginMove.seat_first, 1);
});

test('behavior 3: flag on, a subscription account in its final window: final account wins over seat, then moves to seat when window ends', () => {
  const am = new AccountManager([
    oauth('subFinal', { priority: 0 }),
    oauth('seat', { ...ENTERPRISE, priority: 0, maxDailySpend: 100 }),
    oauth('sub2', { priority: 0 }),
  ], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
    finalWindowHours: 5,
    usageSeatFirst: true,
  });
  am.applyUsageData(1, spend(0));
  bucket(am, 0, 'unified7d', 0.50, 3); // subFinal: resets in 3h -> in final window
  bucket(am, 2, 'unified7d', 0.20, 50);

  // Final window account beats seat
  assert.equal(am._pickBestAvailable(null, OPUS).name, 'subFinal');

  // Place cursor on seat (index 1)
  am.currentIndex = 1;
  const picked = am._select(null, OPUS);
  assert.equal(picked.name, 'subFinal');
  assert.equal(am.currentIndex, 0);
  assert.equal(am.marginMove.final_window, 1);
  assert.equal(am.marginMove.seat_first, 0);

  // When final window ends (reset passes, subFinal now resets in 50h and has fresh quota)
  bucket(am, 0, 'unified7d', 0.05, 50);

  // Now seat wins over subFinal (and sub2)
  assert.equal(am._pickBestAvailable(null, OPUS).name, 'seat');

  // Next select moves cursor back to seat
  const pickedAfterReset = am._select(null, OPUS);
  assert.equal(pickedAfterReset.name, 'seat');
  assert.equal(am.currentIndex, 1);
  assert.equal(am.marginMove.seat_first, 1);
});

test('behavior 4: flag on, seat at its daily cap: seat not chosen, normal balanced among rest, cursor leaves seat', () => {
  const am = new AccountManager([
    oauth('seat', { ...ENTERPRISE, priority: 0, maxDailySpend: 100 }),
    oauth('subLow', { priority: 0 }),
    oauth('subHigh', { priority: 0 }),
  ], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
    usageSeatFirst: true,
  });
  // Baseline spend 50
  am.applyUsageData(0, spend(50_00));
  bucket(am, 1, 'unified7d', 0.20, 50);
  bucket(am, 2, 'unified7d', 0.60, 50);

  // Seat is under cap, so seat is chosen
  assert.equal(am._pickBestAvailable(null, OPUS).name, 'seat');
  assert.equal(am._select(null, OPUS).name, 'seat');
  assert.equal(am.currentIndex, 0);

  // Seat reaches cap (increase of 100 -> total today 100)
  am.applyUsageData(0, spend(150_00));
  assert.equal(am.unavailableReason(am.accounts[0]), 'spend-capped');
  assert.equal(am._isAvailable(am.accounts[0]), false);

  // Seat not chosen; normal balanced among the rest picks subLow
  assert.equal(am._pickBestAvailable(null, OPUS).name, 'subLow');

  // Next select moves cursor off the seat onto subLow
  const picked = am._select(null, OPUS);
  assert.equal(picked.name, 'subLow');
  assert.equal(am.currentIndex, 1);
});

test('behavior 5: flag on, seat with spend.enabled === false (plan-less re-armed): not chosen', () => {
  const am = new AccountManager([
    oauth('seat', { ...ENTERPRISE, priority: 0 }),
    oauth('sub', { priority: 0 }),
  ], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
    usageSeatFirst: true,
  });
  bucket(am, 1, 'unified7d', 0.20, 50);

  // Apply spend.enabled === false for 3 probes to trigger the plan-less gate
  for (let i = 0; i < 3; i++) {
    am.applyUsageData(0, { spend: { enabled: false, disabledReason: 'spend_limit_reached' } });
  }

  assert.equal(am._isAvailable(am.accounts[0]), false);
  assert.equal(am.unavailableReason(am.accounts[0]), 'plan-less');

  // Seat is not chosen
  assert.equal(am._pickBestAvailable(null, OPUS).name, 'sub');
  assert.equal(am._select(null, OPUS).name, 'sub');
});

test('behavior 6: previewRouteIndex/defaultTarget names the seat in case 2 and the final account in case 3', () => {
  // Case 2: seat with sub accounts, cursor on sub
  const amCase2 = new AccountManager([
    oauth('sub', { priority: 0 }),
    oauth('seat', { ...ENTERPRISE, priority: 0, maxDailySpend: 100 }),
    oauth('sub2', { priority: 0 }),
  ], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
    usageSeatFirst: true,
  });
  amCase2.applyUsageData(1, spend(0));
  bucket(amCase2, 0, 'unified7d', 0.20, 50);
  bucket(amCase2, 2, 'unified7d', 0.40, 50);

  assert.equal(amCase2.currentIndex, 0);
  assert.equal(amCase2.previewRouteIndex(OPUS), 1);
  assert.equal(amCase2.getStatus().defaultTarget, 'seat');

  // Case 3: subscription account in final window, cursor on seat
  const amCase3 = new AccountManager([
    oauth('subFinal', { priority: 0 }),
    oauth('seat', { ...ENTERPRISE, priority: 0, maxDailySpend: 100 }),
    oauth('sub2', { priority: 0 }),
  ], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
    finalWindowHours: 5,
    usageSeatFirst: true,
  });
  amCase3.applyUsageData(1, spend(0));
  bucket(amCase3, 0, 'unified7d', 0.50, 3);
  bucket(amCase3, 2, 'unified7d', 0.20, 50);

  amCase3.currentIndex = 1; // cursor on seat
  assert.equal(amCase3.previewRouteIndex(OPUS), 0);
  assert.equal(amCase3.getStatus().defaultTarget, 'subFinal');
});

test('non-balanced strategies: usageSeatFirst has no effect under expiry and drain', () => {
  for (const strategy of ['expiry', 'drain']) {
    const amOn = new AccountManager([
      oauth('sub', { priority: 0 }),
      oauth('seat', { ...ENTERPRISE, priority: 0, maxDailySpend: 100 }),
    ], 0.98, {
      routingStrategy: strategy,
      expiryRouting: { enabled: false },
      usageSeatFirst: true,
    });
    amOn.applyUsageData(1, spend(0));
    bucket(amOn, 0, 'unified7d', 0.20, 50);

    const amOff = new AccountManager([
      oauth('sub', { priority: 0 }),
      oauth('seat', { ...ENTERPRISE, priority: 0, maxDailySpend: 100 }),
    ], 0.98, {
      routingStrategy: strategy,
      expiryRouting: { enabled: false },
      usageSeatFirst: false,
    });
    amOff.applyUsageData(1, spend(0));
    bucket(amOff, 0, 'unified7d', 0.20, 50);

    assert.equal(
      amOn._pickBestAvailable(null, OPUS).name,
      amOff._pickBestAvailable(null, OPUS).name,
      `strategy=${strategy}`
    );
    assert.equal(
      amOn._marginPreemptedBy(amOn.accounts[0]),
      null,
      `strategy=${strategy} marginPreemptedBy is null`
    );
  }
});
