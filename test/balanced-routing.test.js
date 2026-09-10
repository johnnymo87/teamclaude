import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

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

// ---------------------------------------------------------------------------
// 1. The R1 blocker: banding gated on strategy === 'expiry'
// ---------------------------------------------------------------------------

test('R1 blocker: balanced + expiryRouting.enabled preserves all candidates in _topPressureBand (passthrough), not expiry-banded subset', () => {
  // Construct a fleet where account 'a' has high spend and soon reset, and 'b' has low spend and soon reset.
  // Under expiry routing with tolerance 1.5, 'b' has ~3.8x higher expiry pressure than 'a',
  // so 'a' is dropped from the band.
  //
  // 'a': utilization 0.95, reset 2h -> headroom 0.05 / 7200s = 6.94e-6
  // 'b': utilization 0.05, reset 10h -> headroom 0.95 / 36000s = 2.64e-5 (maxKnown)
  // floor = 2.64e-5 / 1.5 = 1.76e-5. 'a' (6.94e-6) < floor, so 'a' is dropped under expiry.
  const now = Date.now();

  // First verify that under 'expiry' strategy, 'a' is indeed dropped:
  const amExpiry = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routingStrategy: 'expiry',
    expiryRouting: { enabled: true, tolerance: 1.5 },
  });
  bucket(amExpiry, 0, 'unified7d', 0.95, 2, now);
  bucket(amExpiry, 1, 'unified7d', 0.05, 10, now);
  assert.deepEqual(
    amExpiry._topPressureBand(amExpiry.accounts, OPUS).map(a => a.name),
    ['b'],
    'precondition: expiry routing drops account a from the top band',
  );

  // Now verify that under 'balanced' strategy with expiryRouting.enabled: true,
  // banding is passthrough and does NOT drop account a:
  const amBalanced = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routingStrategy: 'balanced',
    expiryRouting: { enabled: true, tolerance: 1.5 },
  });
  bucket(amBalanced, 0, 'unified7d', 0.95, 2, now);
  bucket(amBalanced, 1, 'unified7d', 0.05, 10, now);

  const banded = amBalanced._topPressureBand(amBalanced.accounts, OPUS);
  assert.deepEqual(
    banded.map(a => a.name),
    ['a', 'b'],
    'under balanced strategy, _topPressureBand must return ALL candidates (passthrough)',
  );

  // _bandSnapshot must report enabled: false when strategy is balanced:
  const snapshot = amBalanced._bandSnapshot(amBalanced.accounts, OPUS, now);
  assert.equal(snapshot.enabled, false, '_bandSnapshot.enabled must be false under balanced strategy');
});

// ---------------------------------------------------------------------------
// 2. Sign and inversion test: least-utilized must sort first
// ---------------------------------------------------------------------------

test('sign/inversion: balanced routes to the LEAST-utilized account, not the most-spent or highest-expiry-pressure', () => {
  // Construct a fleet where least-utilized is NOT the highest-expiry-pressure account.
  // 'least-utilized': utilization 0.10, reset in 100h -> pressure = 0.90 / (100 * 3600) = 2.5e-6
  // 'most-spent': utilization 0.60, reset in 10h -> pressure = 0.40 / (10 * 3600) = 11.1e-6
  //
  // Under expiry routing: 'most-spent' has higher pressure (11.1e-6 > 2.5e-6) and is preferred.
  // Under balanced routing: 'least-utilized' has lower utilization (0.10 < 0.60) and MUST be picked.
  // If the utilization rank was accidentally negated (-u), 'most-spent' (-0.60 < -0.10) would be picked.
  const now = Date.now();

  const amExpiry = new AccountManager([oauth('least-utilized'), oauth('most-spent')], 0.98, {
    routingStrategy: 'expiry',
    expiryRouting: { enabled: true },
  });
  bucket(amExpiry, 0, 'unified7d', 0.10, 100, now);
  bucket(amExpiry, 1, 'unified7d', 0.60, 10, now);
  assert.equal(
    amExpiry._pickBestAvailable(null, OPUS).name,
    'most-spent',
    'expiry routing picks the higher-pressure account',
  );

  const amBalanced = new AccountManager([oauth('least-utilized'), oauth('most-spent')], 0.98, {
    routingStrategy: 'balanced',
    expiryRouting: { enabled: true },
  });
  bucket(amBalanced, 0, 'unified7d', 0.10, 100, now);
  bucket(amBalanced, 1, 'unified7d', 0.60, 10, now);

  const pressures = amBalanced._rankedPressures(amBalanced.accounts, OPUS, now);
  assert.deepEqual(pressures, [0.10, 0.60], 'pressures must be positive raw utilizations, ascending');
  assert.ok(pressures[0] < pressures[1], 'least-utilized has smaller rank than most-spent');

  const picked = amBalanced._pickBestAvailable(null, OPUS);
  assert.equal(
    picked.name,
    'least-utilized',
    'balanced routing MUST pick the least-utilized account, not the most-spent',
  );
});

test('balanced ranking is model-dependent: accounts score on the bucket governing the requested model', () => {
  // 'a': unified7d = 0.10, unified7dFable = 0.90
  // 'b': unified7d = 0.80, unified7dFable = 0.20
  // Under balanced:
  // For OPUS: a is 0.10, b is 0.80 -> a ranks first
  // For FABLE: a is 0.90, b is 0.20 -> b ranks first
  const now = Date.now();
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routingStrategy: 'balanced',
  });
  bucket(am, 0, 'unified7d', 0.10, 50, now);
  bucket(am, 0, 'unified7dFable', 0.90, 50, now);
  bucket(am, 1, 'unified7d', 0.80, 50, now);
  bucket(am, 1, 'unified7dFable', 0.20, 50, now);

  assert.deepEqual(am._rankedPressures(am.accounts, OPUS, now), [0.10, 0.80]);
  assert.equal(am._pickBestAvailable(null, OPUS).name, 'a');

  assert.deepEqual(am._rankedPressures(am.accounts, FABLE, now), [0.90, 0.20]);
  assert.equal(am._pickBestAvailable(null, FABLE).name, 'b');
});

// ---------------------------------------------------------------------------
// 3. Unknown utilization ranks at median: odd-count and even-count cases
// ---------------------------------------------------------------------------

test('balanced median fallback (odd-count): unknown utilization ranks at median of known candidates, neither first nor last', () => {
  // 3 known candidate utilizations: [0.10, 0.50, 0.90].
  // Median of odd count is middle value = 0.50.
  // Unknown candidate 'u' has null utilization -> must receive rank 0.50.
  const now = Date.now();
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c'), oauth('u')], 0.98, {
    routingStrategy: 'balanced',
  });
  bucket(am, 0, 'unified7d', 0.10, 50, now);
  bucket(am, 1, 'unified7d', 0.50, 50, now);
  bucket(am, 2, 'unified7d', 0.90, 50, now);
  // 'u' has no quota set (utilization is null)
  am.accounts[3].quota.unified7d = null;
  am.accounts[3].quota.unified7dReset = now + 50 * H;
  am.accounts[3].probing = false;

  const pressures = am._rankedPressures(am.accounts, OPUS, now);
  assert.equal(pressures.length, 4);
  assert.equal(pressures[0], 0.10);
  assert.equal(pressures[1], 0.50);
  assert.equal(pressures[2], 0.90);
  assert.equal(pressures[3], 0.50, 'unknown utilization must receive the median of known candidates (0.50)');

  // Assert unknown is neither first nor last:
  assert.ok(pressures[0] < pressures[3], 'account a (0.10) must rank before unknown account u (0.50)');
  assert.ok(pressures[3] < pressures[2], 'unknown account u (0.50) must rank before account c (0.90)');
  assert.notEqual(pressures[3], -Infinity, 'unknown account must NEVER receive -Infinity under balanced');
});

test('balanced median fallback (even-count): unknown and non-finite utilizations rank at median of known candidates', () => {
  // 4 known candidate utilizations: [0.10, 0.30, 0.70, 0.90].
  // Median of even count is average of two middle values: (0.30 + 0.70) / 2 = 0.50.
  // Candidate 'u' (null) and 'n' (NaN) must each receive rank 0.50.
  const now = Date.now();
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c'), oauth('d'), oauth('u'), oauth('n')], 0.98, {
    routingStrategy: 'balanced',
  });
  bucket(am, 0, 'unified7d', 0.10, 50, now);
  bucket(am, 1, 'unified7d', 0.30, 50, now);
  bucket(am, 2, 'unified7d', 0.70, 50, now);
  bucket(am, 3, 'unified7d', 0.90, 50, now);
  am.accounts[4].quota.unified7d = null;
  am.accounts[4].quota.unified7dReset = now + 50 * H;
  am.accounts[4].probing = false;
  am.accounts[5].quota.unified7d = NaN;
  am.accounts[5].quota.unified7dReset = now + 50 * H;
  am.accounts[5].probing = false;

  const pressures = am._rankedPressures(am.accounts, OPUS, now);
  assert.equal(pressures[4], 0.50, 'null utilization receives even-count median 0.50');
  assert.equal(pressures[5], 0.50, 'non-finite (NaN) utilization receives even-count median 0.50');

  // Strictly between lower half [0.10, 0.30] and upper half [0.70, 0.90]:
  assert.ok(pressures[0] < pressures[4]);
  assert.ok(pressures[1] < pressures[4]);
  assert.ok(pressures[4] < pressures[2]);
  assert.ok(pressures[4] < pressures[3]);
});

// ---------------------------------------------------------------------------
// 4. All-unknown fleet: pressure term is constant and inert
// ---------------------------------------------------------------------------

test('all-unknown fleet under balanced: pressure term is constant and inert, never -Infinity', () => {
  const now = Date.now();
  const am = new AccountManager([oauth('u1'), oauth('u2'), oauth('u3')], 0.98, {
    routingStrategy: 'balanced',
  });
  // All have unknown/null quota, but different resets to test tiebreak
  am.accounts[0].quota.unified7d = null;
  am.accounts[0].quota.unified7dReset = now + 50 * H;
  am.accounts[0].probing = false;

  am.accounts[1].quota.unified7d = null;
  am.accounts[1].quota.unified7dReset = now + 10 * H; // resets soonest
  am.accounts[1].probing = false;

  am.accounts[2].quota.unified7d = null;
  am.accounts[2].quota.unified7dReset = now + 100 * H;
  am.accounts[2].probing = false;

  const pressures = am._rankedPressures(am.accounts, OPUS, now);
  assert.deepEqual(pressures, [0, 0, 0], 'all-unknown candidates receive constant inert 0');
  for (const p of pressures) {
    assert.notEqual(p, -Infinity, 'no candidate receives -Infinity under balanced');
  }

  // With pressure term inert across all candidates, tiebreak falls to reset time:
  const best = am._pickBestAvailable(null, OPUS);
  assert.equal(best.name, 'u2', 'falls back to soonest reset when pressure is inert');
});

// ---------------------------------------------------------------------------
// 5. 'drain' strategy: banding disabled and pressures constant
// ---------------------------------------------------------------------------

test('drain strategy: banding is disabled and ranked pressures are constant even with expiryRouting.enabled: true', () => {
  const now = Date.now();
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routingStrategy: 'drain',
    expiryRouting: { enabled: true, tolerance: 1.5 },
  });
  bucket(am, 0, 'unified7d', 0.95, 2, now);
  bucket(am, 1, 'unified7d', 0.05, 10, now);

  // Band snapshot enabled must be false:
  const snapshot = am._bandSnapshot(am.accounts, OPUS, now);
  assert.equal(snapshot.enabled, false, '_bandSnapshot.enabled is false under drain');

  // _topPressureBand returns all candidates:
  assert.deepEqual(
    am._topPressureBand(am.accounts, OPUS).map(a => a.name),
    ['a', 'b'],
    '_topPressureBand returns all candidates under drain',
  );

  // _rankedPressures returns constant expiry-routing-off (-Infinity) for every candidate:
  const pressures = am._rankedPressures(am.accounts, OPUS, now);
  assert.deepEqual(pressures, [-Infinity, -Infinity], 'drain returns constant -Infinity for all candidates');

  // _belowBandFloor returns all zeros:
  assert.deepEqual(am._belowBandFloor(am.accounts, OPUS, now), [0, 0]);
});

// ---------------------------------------------------------------------------
// 6. 'expiry' strategy: regression guard
// ---------------------------------------------------------------------------

test('expiry strategy regression guard: paths behave unchanged with expiryRouting enabled and disabled', () => {
  const now = Date.now();

  // With expiryRouting.enabled: true
  const amOn = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routingStrategy: 'expiry',
    expiryRouting: { enabled: true, tolerance: 1.5 },
  });
  bucket(amOn, 0, 'unified7d', 0.95, 2, now);
  bucket(amOn, 1, 'unified7d', 0.05, 10, now);

  assert.equal(amOn._bandSnapshot(amOn.accounts, OPUS, now).enabled, true);
  assert.deepEqual(amOn._topPressureBand(amOn.accounts, OPUS).map(a => a.name), ['b']);
  const onPressures = amOn._rankedPressures(amOn.accounts, OPUS, now);
  assert.ok(onPressures[0] < 0 && onPressures[1] < 0, 'expiry pressureRank produces negative numbers');
  assert.ok(onPressures[1] < onPressures[0], 'higher pressure has more negative rank, sorting first');

  // With expiryRouting.enabled: false
  const amOff = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routingStrategy: 'expiry',
    expiryRouting: { enabled: false },
  });
  bucket(amOff, 0, 'unified7d', 0.95, 2, now);
  bucket(amOff, 1, 'unified7d', 0.05, 10, now);

  assert.equal(amOff._bandSnapshot(amOff.accounts, OPUS, now).enabled, false);
  assert.deepEqual(amOff._topPressureBand(amOff.accounts, OPUS).map(a => a.name), ['a', 'b']);
  assert.deepEqual(amOff._rankedPressures(amOff.accounts, OPUS, now), [-Infinity, -Infinity]);
  assert.deepEqual(amOff._belowBandFloor(amOff.accounts, OPUS, now), [0, 0]);
});

// ---------------------------------------------------------------------------
// 7. _rankingReset under balanced reads governing window resetAt
// ---------------------------------------------------------------------------

test('rankingReset under balanced reads governing window resetAt, including scoped bucket differing from governingWeeklyReset', () => {
  const now = Date.now();
  const SHARED_RESET = now + 100 * H;
  const SCOPED_RESET = now + 15 * H;

  // Under balanced, _rankingReset must read _governingWindow(account, model).resetAt.
  // In this fixture, account has unified7d at 0.30 (reset SHARED_RESET),
  // but scopedWeekly for opus at 0.80 (reset SCOPED_RESET).
  // Because scoped utilization (0.80) > shared (0.30), the scoped window governs for OPUS!
  // _governingWeeklyReset returns SHARED_RESET (named bucket).
  // _governingWindow.resetAt returns SCOPED_RESET.
  const amBalanced = new AccountManager([oauth('a')], 0.98, {
    routingStrategy: 'balanced',
    expiryRouting: { enabled: false }, // even with expiryRouting.enabled: false!
  });
  Object.assign(amBalanced.accounts[0].quota, {
    unified7d: 0.30,
    unified7dReset: SHARED_RESET,
    scopedWeekly: { opus: { utilization: 0.80, resetAt: SCOPED_RESET } },
  });

  assert.equal(amBalanced._governingWeeklyReset(amBalanced.accounts[0], OPUS), SHARED_RESET);
  assert.equal(amBalanced._governingWindow(amBalanced.accounts[0], OPUS).resetAt, SCOPED_RESET);
  assert.equal(
    amBalanced._rankingReset(amBalanced.accounts[0], OPUS),
    SCOPED_RESET,
    '_rankingReset under balanced must return governing window resetAt, not named bucket reset',
  );

  // Check regression: under 'expiry' with expiryRouting.enabled: false,
  // _rankingReset still returns _governingWeeklyReset (SHARED_RESET):
  const amExpiryOff = new AccountManager([oauth('a')], 0.98, {
    routingStrategy: 'expiry',
    expiryRouting: { enabled: false },
  });
  Object.assign(amExpiryOff.accounts[0].quota, {
    unified7d: 0.30,
    unified7dReset: SHARED_RESET,
    scopedWeekly: { opus: { utilization: 0.80, resetAt: SCOPED_RESET } },
  });
  assert.equal(amExpiryOff._rankingReset(amExpiryOff.accounts[0], OPUS), SHARED_RESET);

  // Under 'expiry' with expiryRouting.enabled: true, it returns governing window resetAt:
  const amExpiryOn = new AccountManager([oauth('a')], 0.98, {
    routingStrategy: 'expiry',
    expiryRouting: { enabled: true },
  });
  Object.assign(amExpiryOn.accounts[0].quota, {
    unified7d: 0.30,
    unified7dReset: SHARED_RESET,
    scopedWeekly: { opus: { utilization: 0.80, resetAt: SCOPED_RESET } },
  });
  assert.equal(amExpiryOn._rankingReset(amExpiryOn.accounts[0], OPUS), SCOPED_RESET);

  // Under 'drain' with expiryRouting.enabled: false, it returns _governingWeeklyReset:
  const amDrainOff = new AccountManager([oauth('a')], 0.98, {
    routingStrategy: 'drain',
    expiryRouting: { enabled: false },
  });
  Object.assign(amDrainOff.accounts[0].quota, {
    unified7d: 0.30,
    unified7dReset: SHARED_RESET,
    scopedWeekly: { opus: { utilization: 0.80, resetAt: SCOPED_RESET } },
  });
  assert.equal(amDrainOff._rankingReset(amDrainOff.accounts[0], OPUS), SHARED_RESET);
});

// ---------------------------------------------------------------------------
// 8. _belowBandFloor inert under non-expiry strategies
// ---------------------------------------------------------------------------

test('belowBandFloor returns all zeros under balanced and drain even with expiryRouting enabled', () => {
  // Construct candidates where an expiry floor would hold someone off:
  // Account 'a' has known utilization and clock -> known pressure.
  // Account 'spent-noclock' has 0.95 utilization but no reset -> bounded absence with lowerBound.
  // Under expiry routing, 'spent-noclock' is below floor and gets heldOff = 1.
  const now = Date.now();
  const build = strategy => {
    const am = new AccountManager([oauth('a'), oauth('spent-noclock')], 0.98, {
      routingStrategy: strategy,
      expiryRouting: { enabled: true, tolerance: 1.5 },
    });
    bucket(am, 0, 'unified7d', 0.10, 10, now);
    const q = am.accounts[1].quota;
    q.unified7d = 0.95;
    q.unified7dReset = null; // no clock -> lowerBound is ~0.05 / (7 * 86400)
    am.accounts[1].probing = false;
    return am;
  };

  const amExpiry = build('expiry');
  const expiryHeldOff = amExpiry._belowBandFloor(amExpiry.accounts, OPUS, now);
  assert.deepEqual(expiryHeldOff, [0, 1], 'precondition: expiry routing holds off spent-noclock');

  const amBalanced = build('balanced');
  assert.deepEqual(
    amBalanced._belowBandFloor(amBalanced.accounts, OPUS, now),
    [0, 0],
    'balanced strategy makes _belowBandFloor inert (all zeros)',
  );

  const amDrain = build('drain');
  assert.deepEqual(
    amDrain._belowBandFloor(amDrain.accounts, OPUS, now),
    [0, 0],
    'drain strategy makes _belowBandFloor inert (all zeros)',
  );
});

// ---------------------------------------------------------------------------
// 9. Disable _switchOnSessionReset under balanced (D4 [R1])
// ---------------------------------------------------------------------------

test('under balanced strategy, session-quota reset does NOT move currentIndex even when another account weekly resets sooner and ranks equal-or-better', () => {
  const now = Date.now();

  function makeFleet(strategy, aUtil = 0.2, bUtil = 0.5) {
    const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
      routingStrategy: strategy,
    });
    const [a, b] = am.accounts;
    // a has rolled 5h window (just reset), weekly expires soon (6h)
    a.quota.unified5h = 0.99;
    a.quota.unified5hReset = now - 1000;
    a.quota.unified7d = aUtil;
    a.quota.unified7dReset = now + 6 * H;
    a.probing = false;

    // b is current, weekly expires much later (58h)
    b.quota.unified5h = 0.2;
    b.quota.unified5hReset = now + 4 * H;
    b.quota.unified7d = bUtil;
    b.quota.unified7dReset = now + 58 * H;
    b.probing = false;

    am.currentIndex = 1; // current = b
    return am;
  }

  // 1. Better rank: a has lower utilization (0.1 vs 0.5)
  const amBetter = makeFleet('balanced', 0.1, 0.5);
  amBetter.refreshExpiredQuotas();
  assert.equal(
    amBetter.currentIndex,
    1,
    'balanced strategy must not move currentIndex on session reset even when candidate has better rank',
  );

  // 2. Equal rank: a has equal utilization (0.2 vs 0.2)
  const amEqual = makeFleet('balanced', 0.2, 0.2);
  amEqual.refreshExpiredQuotas();
  assert.equal(
    amEqual.currentIndex,
    1,
    'balanced strategy must not move currentIndex on session reset even when candidate has equal rank',
  );

  // 3. Direct call to _switchOnSessionReset is also early-returned
  const amDirect = makeFleet('balanced', 0.1, 0.5);
  amDirect._switchOnSessionReset([amDirect.accounts[0]]);
  assert.equal(
    amDirect.currentIndex,
    1,
    '_switchOnSessionReset must early-return under balanced',
  );
});

test('under expiry and drain strategies, session-quota reset behaviour is unchanged', () => {
  const now = Date.now();

  function makeFleet(strategy, aUtil = 0.2, bUtil = 0.5) {
    const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
      routingStrategy: strategy,
    });
    const [a, b] = am.accounts;
    a.quota.unified5h = 0.99;
    a.quota.unified5hReset = now - 1000;
    a.quota.unified7d = aUtil;
    a.quota.unified7dReset = now + 6 * H;
    a.probing = false;

    b.quota.unified5h = 0.2;
    b.quota.unified5hReset = now + 4 * H;
    b.quota.unified7d = bUtil;
    b.quota.unified7dReset = now + 58 * H;
    b.probing = false;

    am.currentIndex = 1;
    return am;
  }

  // Under expiry strategy: switches to a
  const amExpiry = makeFleet('expiry', 0.2, 0.2);
  amExpiry.refreshExpiredQuotas();
  assert.equal(
    amExpiry.currentIndex,
    0,
    'expiry strategy must still switch to account whose weekly expires sooner',
  );

  // Under drain strategy: switches to a
  const amDrain = makeFleet('drain', 0.2, 0.2);
  amDrain.refreshExpiredQuotas();
  assert.equal(
    amDrain.currentIndex,
    0,
    'drain strategy must still switch to account whose weekly expires sooner',
  );
});
