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
// 8. _belowBandFloor under balanced and drain strategies
// ---------------------------------------------------------------------------

test('belowBandFloor holds off on W margin under balanced and returns all zeros under drain', () => {
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
    [0, 1],
    'balanced strategy holds off spent-noclock whose W exceeds margin over cheapest candidate',
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

// ---------------------------------------------------------------------------
// 10. Margin preemption (_marginPreemptedBy) and cycle-freedom (D4, D5)
// ---------------------------------------------------------------------------

test('margin preemption and heldOff: float boundary at exact margin across IEEE754 representation pairs', () => {
  const margin = 0.10;
  const pairs = [
    [0.25, 0.15],
    [0.30, 0.20],
    [0.60, 0.50],
    [0.97, 0.87],
    [0.80, 0.70],
    [0.40, 0.30],
    [0.70, 0.60],
    [0.90, 0.80],
    [0.12, 0.02],
  ];

  for (const [wCurrent, wBest] of pairs) {
    const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
      routingStrategy: 'balanced',
      weeklyBalanceMargin: margin,
    });
    const [a, b] = am.accounts;
    am.currentIndex = 0; // a is current

    bucket(am, 1, 'unified7d', wBest, 50);

    // Below margin: 0.01 less than exact margin
    bucket(am, 0, 'unified7d', Number((wCurrent - 0.01).toFixed(4)), 50);
    assert.equal(
      am._marginPreemptedBy(a),
      null,
      `_marginPreemptedBy must NOT fire below margin for pair [${(wCurrent - 0.01).toFixed(4)}, ${wBest}]`,
    );
    assert.deepEqual(
      am._belowBandFloor([b, a], null, Date.now()),
      [0, 0],
      `_belowBandFloor must NOT hold off below margin for pair [${(wCurrent - 0.01).toFixed(4)}, ${wBest}]`,
    );

    // Exact margin: MUST fire
    bucket(am, 0, 'unified7d', wCurrent, 50);
    const preemptor = am._marginPreemptedBy(a);
    assert.equal(
      preemptor?.name,
      'b',
      `_marginPreemptedBy MUST fire at exact margin for pair [${wCurrent}, ${wBest}] (diff: ${wCurrent - wBest})`,
    );

    const selected = am.getActiveAccount();
    assert.equal(
      selected.name,
      'b',
      `selection MUST switch to best at exact margin for pair [${wCurrent}, ${wBest}]`,
    );

    // _belowBandFloor balanced branch: candidate with wCurrent is held off (1), wBest is not (0)
    const heldOff = am._belowBandFloor([b, a], null, Date.now());
    assert.deepEqual(
      heldOff,
      [0, 1],
      `_belowBandFloor MUST hold off account at exact margin for pair [${wCurrent}, ${wBest}] (diff: ${wCurrent - wBest})`,
    );
  }
});

test('margin preemption: fires when W(current) - W(best) >= margin, does NOT fire at margin - epsilon, DOES fire at exact margin', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
  });
  const [a] = am.accounts;
  am.currentIndex = 0; // a is current

  // wBest = 0.15
  bucket(am, 1, 'unified7d', 0.15, 50);

  // 1. margin - epsilon (0.249 - 0.15 = 0.099 < 0.10): must NOT fire
  bucket(am, 0, 'unified7d', 0.249, 50);
  assert.equal(
    am._marginPreemptedBy(a),
    null,
    '_marginPreemptedBy must return null when W diff < margin',
  );
  let selected = am.getActiveAccount();
  assert.equal(selected.name, 'a', 'selection must stay on current when W diff < margin');
  assert.equal(am.currentIndex, 0);

  // 2. exact margin (0.25 - 0.15 = 0.10 >= 0.10): MUST fire
  bucket(am, 0, 'unified7d', 0.25, 50);
  const preemptor = am._marginPreemptedBy(a);
  assert.equal(preemptor?.name, 'b', '_marginPreemptedBy MUST return best at exact margin boundary');
  selected = am.getActiveAccount();
  assert.equal(selected.name, 'b', 'selection MUST switch to best at exact margin boundary');
  assert.equal(am.currentIndex, 1);

  // 3. strictly above margin (0.35 - 0.15 = 0.20 >= 0.10): MUST fire
  am.currentIndex = 0;
  bucket(am, 0, 'unified7d', 0.35, 50);
  assert.equal(am._marginPreemptedBy(a)?.name, 'b');
  selected = am.getActiveAccount();
  assert.equal(selected.name, 'b');
  assert.equal(am.currentIndex, 1);
});

test('margin preemption threads preselected winner into _selectNext to preserve D4 precondition 4', () => {
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
  });
  const [, , c] = am.accounts;
  am.currentIndex = 0; // a is current
  bucket(am, 0, 'unified7d', 0.50, 50);
  bucket(am, 1, 'unified7d', 0.20, 50);
  bucket(am, 2, 'unified7d', 0.05, 50);

  // c is currently throttled / unavailable
  c.status = 'throttled';
  c.rateLimitedUntil = Date.now() + 60_000;
  c.throttledAt = Date.now();

  // Intercept _pickBestAvailable so after the first call (from _marginPreemptedBy),
  // c becomes available. Without preselected threaded through, _selectNext's
  // un-threaded call would recompute _pickBestAvailable and pick c rather than
  // b (the margin-tested winner).
  let callCount = 0;
  const origPick = am._pickBestAvailable.bind(am);
  am._pickBestAvailable = (...args) => {
    callCount++;
    const res = origPick(...args);
    if (callCount === 1) {
      // First call was from _marginPreemptedBy: now make c available
      c.status = 'ok';
      c.rateLimitedUntil = null;
    }
    return res;
  };

  const selected = am.getActiveAccount(null, OPUS);
  assert.equal(
    selected.name,
    'b',
    'selection MUST switch to b (the margin-tested winner), not c (which became available afterwards)',
  );
  assert.equal(am.currentIndex, 1, 'currentIndex must be account b');
});

test('eligibility() under balanced routing reports ineligibility when outranked on weekly balance', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
  });
  am.currentIndex = 0;
  bucket(am, 0, 'unified7d', 0.50, 50);
  bucket(am, 1, 'unified7d', 0.20, 50);

  const initialCounters = { ...am.marginMove };

  // 1. Account a has W 0.50, b has W 0.20 (diff 0.30 >= margin 0.10) -> ineligible
  const resA = am.eligibility(0);
  assert.equal(resA.eligible, false);
  assert.equal(resA.reason, 'outranked on weekly balance by "b"');

  // Must not touch marginMove counters ({ count: false })
  assert.deepEqual(am.marginMove, initialCounters, 'eligibility query must not increment marginMove counters');

  // 2. Account b is best -> eligible
  const resB = am.eligibility(1);
  assert.equal(resB.eligible, true);
  assert.deepEqual(am.marginMove, initialCounters);

  // 3. Below margin: W diff 0.05 < margin 0.10 -> both eligible
  bucket(am, 0, 'unified7d', 0.25, 50);
  const resBelow = am.eligibility(0);
  assert.equal(resBelow.eligible, true);
  assert.deepEqual(am.marginMove, initialCounters);

  // 4. Under expiry strategy: margin is not consulted, so a is eligible
  const amExpiry = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routingStrategy: 'expiry',
    weeklyBalanceMargin: 0.10,
  });
  bucket(amExpiry, 0, 'unified7d', 0.50, 50);
  bucket(amExpiry, 1, 'unified7d', 0.20, 50);
  assert.equal(amExpiry.eligibility(0).eligible, true);
});

test('spill guards: unified5h >= 0.90 and pausedUntil in future independently block margin move; cleared guards allow it', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
  });
  const [a, b] = am.accounts;
  am.currentIndex = 0; // a is current
  bucket(am, 0, 'unified7d', 0.60, 50);
  bucket(am, 1, 'unified7d', 0.10, 50); // W diff = 0.50 >= 0.10

  // Guard 1: unified5h = 0.95 (>= 0.90) blocks
  b.quota.unified5h = 0.95;
  b.pausedUntil = null;
  assert.equal(
    am._marginPreemptedBy(a),
    null,
    'unified5h >= 0.90 must block margin preemption',
  );
  assert.equal(am.getActiveAccount().name, 'a', 'selection must stay on a when unified5h blocks');
  assert.equal(am.currentIndex, 0);

  // Clear Guard 1: unified5h = 0.89 (< 0.90) -> move happens
  b.quota.unified5h = 0.89;
  assert.equal(
    am._marginPreemptedBy(a)?.name,
    'b',
    'clearing unified5h guard must allow margin preemption',
  );
  assert.equal(am.getActiveAccount().name, 'b');
  assert.equal(am.currentIndex, 1);

  // Guard 2: pausedUntil in future blocks
  am.currentIndex = 0;
  b.quota.unified5h = 0.10;
  b.pausedUntil = Date.now() + 60_000;
  assert.equal(
    am._marginPreemptedBy(a),
    null,
    'pausedUntil in future must block margin preemption',
  );
  assert.equal(am.getActiveAccount().name, 'a', 'selection must stay on a when pausedUntil blocks');
  assert.equal(am.currentIndex, 0);

  // Clear Guard 2: pausedUntil = null -> move happens
  b.pausedUntil = null;
  assert.equal(
    am._marginPreemptedBy(a)?.name,
    'b',
    'clearing pausedUntil guard must allow margin preemption',
  );
  assert.equal(am.getActiveAccount().name, 'b');
  assert.equal(am.currentIndex, 1);
});

test('priority interaction: strictly higher-priority preempts regardless of margin; strictly lower-priority never taken on margin even with huge W gap', () => {
  // Part A: higher-priority (lower priority number) preempts regardless of margin
  const amHigher = new AccountManager([oauth('a', { priority: 1 }), oauth('b', { priority: 0 })], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
  });
  amHigher.currentIndex = 0;
  bucket(amHigher, 0, 'unified7d', 0.20, 50);
  bucket(amHigher, 1, 'unified7d', 0.20, 50); // W diff = 0 < 0.10 (no margin move)

  assert.equal(
    amHigher._marginPreemptedBy(amHigher.accounts[0]),
    null,
    'margin preemption does not fire when W diff is zero',
  );
  assert.equal(
    amHigher._preemptedBy(amHigher.accounts[0])?.name,
    'b',
    'priority preemption must fire because b has higher priority (0 < 1)',
  );
  assert.equal(
    amHigher.getActiveAccount().name,
    'b',
    'selection must route to b by priority preemption',
  );
  assert.equal(amHigher.currentIndex, 1);

  // Part B: strictly lower-priority (higher priority number) is NEVER taken on margin even with huge W gap.
  // Reachability note: from _select, current is available, so _pickBestAvailable ranks priority
  // first and will return current before any strictly lower-priority account. The explicit priority
  // guard in _marginPreemptedBy (`(best.priority || 0) > (current.priority || 0)`) is defense-in-depth
  // guaranteeing D4 precondition 4. We test both the guard in isolation and integrated selection:
  const amLower = new AccountManager([oauth('a', { priority: 0 }), oauth('b', { priority: 1 })], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
  });
  amLower.currentIndex = 0;
  bucket(amLower, 0, 'unified7d', 0.95, 50);
  bucket(amLower, 1, 'unified7d', 0.05, 50); // W diff = 0.90 >> 0.10

  assert.equal(
    amLower._preemptedBy(amLower.accounts[0]),
    null,
    'b does not priority-preempt a',
  );

  // Unit test of the priority guard in isolation: excluding current forces _pickBestAvailable to pick b (priority 1),
  // directly exercising the (best.priority > current.priority) check in _marginPreemptedBy.
  assert.equal(
    amLower._marginPreemptedBy(amLower.accounts[0], null, null, new Set([0])),
    null,
    'unit test of guard in isolation: _marginPreemptedBy rejects best when best.priority > current.priority',
  );

  assert.equal(
    amLower._marginPreemptedBy(amLower.accounts[0]),
    null,
    'margin preemption must NEVER take a strictly lower-priority account even with huge W gap',
  );
  assert.equal(
    amLower.getActiveAccount().name,
    'a',
    'selection must stay on higher-priority current account a',
  );
  assert.equal(amLower.currentIndex, 0);
});

test('_setCurrent is used on margin move: first-sight observation is seeded', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
    expiryRouting: { enabled: true, preempt: true },
  });
  const [, b] = am.accounts;
  am.currentIndex = 0;
  bucket(am, 0, 'unified7d', 0.50, 50);
  bucket(am, 1, 'unified7d', 0.10, 50);
  b.quota.unified7dReset = Date.now() + 50 * H;

  // Before margin move, _currentObs has not been seeded for b
  assert.notEqual(am._currentObs?.idx, 1);

  const selected = am.getActiveAccount();
  assert.equal(selected.name, 'b');
  assert.equal(am.currentIndex, 1);

  // Observable consequence of _setCurrent: _firstSightOn ran and seeded _currentObs
  assert.ok(am._currentObs != null, '_currentObs must be initialized');
  assert.equal(am._currentObs.idx, 1, '_currentObs.idx must name account b (index 1)');
  assert.ok(am._currentObs.windows instanceof Map, '_currentObs.windows must be a Map');
  assert.ok(am._currentObs.windows.size > 0, '_currentObs.windows must contain seeded window baselines');
});

test('W evaluation bound: a selection decision evaluates W a bounded number of times', () => {
  // A direct _select decision evaluates _computeAllW at most once across all candidates.
  // Note: if session distribution is active and falls through to placement (_pickLeastLoaded),
  // _belowBandFloor legitimately computes W a second time with the identical snapshot value.
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c'), oauth('d')], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
  });
  am.currentIndex = 0;
  bucket(am, 0, 'unified7d', 0.80, 50);
  bucket(am, 1, 'unified7d', 0.60, 50);
  bucket(am, 2, 'unified7d', 0.40, 50);
  bucket(am, 3, 'unified7d', 0.10, 50);

  let computeCount = 0;
  const origComputeAllW = am._computeAllW.bind(am);
  am._computeAllW = () => {
    computeCount++;
    return origComputeAllW();
  };

  // Run selection across candidate accounts
  const selected = am.getActiveAccount();
  assert.equal(selected.name, 'd');
  assert.equal(
    computeCount,
    1,
    'direct selection decision evaluates W exactly once',
  );

  // When session placement routes through _pickLeastLoaded, _belowBandFloor computes W again:
  computeCount = 0;
  const amSession = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
    distributeSessions: true,
  });
  bucket(amSession, 0, 'unified7d', 0.50, 50);
  bucket(amSession, 1, 'unified7d', 0.20, 50);
  amSession._computeAllW = () => {
    computeCount++;
    return origComputeAllW();
  };
  amSession.beginSession('new-sess');
  amSession.getActiveAccount(null, OPUS, null, 'new-sess');
  amSession.endSession('new-sess');
  assert.ok(
    computeCount <= 2,
    `session placement decision evaluates W at most twice (got ${computeCount})`,
  );
});

test('steady-state fixpoint: alternating models with opposing utilization settle and do not flap across requests', () => {
  // A has unified7d: 0.30, unified7dFable: 0.10 -> W(A) = 0.30
  // B has unified7d: 0.10, unified7dFable: 0.30 -> W(B) = 0.10
  // Margin = 0.10. W(A) - W(B) = 0.20 >= margin.
  //
  // Model-dependent ranking alone would flap indefinitely between models:
  // - OPUS prefers B (unified7d 0.10 < 0.30)
  // - FABLE prefers A (unified7dFable 0.10 < 0.30)
  //
  // But model-independent W keeps the cursor still once on B:
  // When cursor is on B and request is FABLE, A ranks best for FABLE,
  // but W(B) - W(A) = 0.10 - 0.30 = -0.20 < margin, so margin preemption
  // refuses to move. Cursor settles on B and stays there across alternating requests.
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
  });
  am.currentIndex = 0; // starts on a
  bucket(am, 0, 'unified7d', 0.30, 50);
  bucket(am, 0, 'unified7dFable', 0.10, 50);
  bucket(am, 1, 'unified7d', 0.10, 50);
  bucket(am, 1, 'unified7dFable', 0.30, 50);

  const models = [OPUS, FABLE];
  let moves = 0;
  let lastIndex = am.currentIndex;
  for (let i = 0; i < 20; i++) {
    const model = models[i % 2];
    const chosen = am.getActiveAccount(null, model);
    if (chosen.index !== lastIndex) {
      moves++;
      lastIndex = chosen.index;
    }
  }

  // Must settle in at most 1 move (from a to b on the first OPUS request)
  // and NEVER flap back to a on subsequent FABLE requests.
  assert.ok(
    moves <= 1,
    `cursor flapped: moved ${moves} times across alternating models (must be <= 1)`,
  );
  assert.equal(lastIndex, 1, 'cursor must settle on account b (lowest W)');
  assert.equal(am.currentIndex, 1, 'currentIndex must stay parked on b');

  // Verify fixpoint stability across 10 further alternating requests:
  for (let i = 0; i < 10; i++) {
    const model = models[i % 2];
    const chosen = am.getActiveAccount(null, model);
    assert.equal(chosen.name, 'b', `request ${i} for ${model} must stay on b`);
    assert.equal(am.currentIndex, 1);
  }
});

test('expiry and drain strategies are unaffected: _marginPreemptedBy returns null and selection is unchanged', () => {
  for (const strategy of ['expiry', 'drain']) {
    const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
      routingStrategy: strategy,
      weeklyBalanceMargin: 0.10,
    });
    am.currentIndex = 0;
    bucket(am, 0, 'unified7d', 0.90, 50);
    bucket(am, 1, 'unified7d', 0.10, 50); // W diff = 0.80 >> 0.10

    assert.equal(
      am._marginPreemptedBy(am.accounts[0]),
      null,
      `_marginPreemptedBy must return null under ${strategy} strategy`,
    );

    const selected = am.getActiveAccount();
    assert.equal(
      selected.name,
      'a',
      `selection must stay on current account under ${strategy} strategy (margin ignored)`,
    );
    assert.equal(am.currentIndex, 0);
  }
});

// ---------------------------------------------------------------------------
// Task A (D7): Mirror margin preemption at previewRouteIndex and _selectForSession
// ---------------------------------------------------------------------------

test('previewRouteIndex agrees with actual selection under balanced margin preemption and does not mutate', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
  });
  am.currentIndex = 0;
  bucket(am, 0, 'unified7d', 0.80, 50);
  bucket(am, 1, 'unified7d', 0.20, 50);

  // Read-only verification before preview
  assert.equal(am.currentIndex, 0);
  assert.equal(am._currentObs, null);

  // 1. With W gap >= margin, previewRouteIndex reports the margin winner (b, index 1)
  // and NOT the current account (a, index 0).
  const previewIdx = am.previewRouteIndex(OPUS);
  assert.equal(previewIdx, 1, 'previewRouteIndex must report margin winner (b, index 1), not current (a, index 0)');

  // 2. previewRouteIndex is read-only and mutates nothing
  assert.equal(am.currentIndex, 0, 'previewRouteIndex must not mutate currentIndex');
  assert.equal(am._currentObs, null, 'previewRouteIndex must not seed _currentObs');
  assert.equal(am.accounts[1].ramping, undefined, 'previewRouteIndex must not begin ramp');

  // 3. previewRouteIndex answer equals what actual selection does (they must agree)
  const actual = am.getActiveAccount(null, OPUS);
  assert.equal(actual.index, previewIdx, 'previewRouteIndex answer must agree with actual selection');
  assert.equal(actual.name, 'b');
  assert.equal(am.currentIndex, 1, 'actual selection updates currentIndex to margin winner');

  // 4. Subcase: with W gap < margin, previewRouteIndex stays on current account
  const amSmall = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
  });
  amSmall.currentIndex = 0;
  bucket(amSmall, 0, 'unified7d', 0.25, 50);
  bucket(amSmall, 1, 'unified7d', 0.20, 50); // gap = 0.05 < 0.10
  const previewSmall = amSmall.previewRouteIndex(OPUS);
  assert.equal(previewSmall, 0, 'previewRouteIndex stays on current account when gap < margin');
  const actualSmall = amSmall.getActiveAccount(null, OPUS);
  assert.equal(actualSmall.index, previewSmall, 'previewRouteIndex and actual selection must agree when gap < margin');
  assert.equal(actualSmall.name, 'a');
});

test('session pin re-routes under balanced when behind margin, stays pinned below margin', () => {
  // Case 1: W gap >= margin -> session pin re-routes
  const amReRoute = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
    distributeSessions: true,
  });
  bucket(amReRoute, 0, 'unified7d', 0.80, 50);
  bucket(amReRoute, 1, 'unified7d', 0.20, 50);
  amReRoute.recordSession('s1', 0, OPUS); // pinned to account a (index 0)
  assert.equal(amReRoute.sessionTracker.pinnedAccount('s1', 'unified7d'), 0);

  const selectedReRoute = amReRoute.getActiveAccount(null, OPUS, null, 's1');
  assert.equal(
    selectedReRoute.name,
    'b',
    'session pinned to account behind margin must re-route to margin winner',
  );

  // Case 2: W gap < margin -> stays pinned
  const amStay = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
    distributeSessions: true,
  });
  bucket(amStay, 0, 'unified7d', 0.25, 50);
  bucket(amStay, 1, 'unified7d', 0.20, 50); // gap 0.05 < 0.10
  amStay.recordSession('s2', 0, OPUS); // pinned to account a (index 0)
  assert.equal(amStay.sessionTracker.pinnedAccount('s2', 'unified7d'), 0);

  const selectedStay = amStay.getActiveAccount(null, OPUS, null, 's2');
  assert.equal(
    selectedStay.name,
    'a',
    'session pinned to account within margin must stay pinned',
  );

  // Case 3: W frozen across multiple candidate checks in _selectForSession
  const amMulti = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
    distributeSessions: true,
  });
  // a: 0.80 (preempted by c at 0.10, gap 0.70 >= 0.10)
  // b: 0.15 (not preempted by c at 0.10, gap 0.05 < 0.10)
  // c: 0.10 (cheapest)
  bucket(amMulti, 0, 'unified7d', 0.80, 50);
  bucket(amMulti, 1, 'unified7d', 0.15, 50);
  bucket(amMulti, 2, 'unified7d', 0.10, 50);
  amMulti.recordSession('s3', 0, OPUS);
  amMulti.recordSession('s3', 1, FABLE);

  let computeCount = 0;
  const origComputeAllW = amMulti._computeAllW.bind(amMulti);
  amMulti._computeAllW = () => {
    computeCount++;
    return origComputeAllW();
  };

  // Checks candidate a (preempted, computes allW), then candidate b (reuses allW, not preempted -> returned)
  const selectedMulti = amMulti.getActiveAccount(null, OPUS, null, 's3');
  assert.equal(selectedMulti.name, 'b');
  assert.equal(
    computeCount,
    1,
    '_computeAllW must be called at most once across multiple candidates in _selectForSession',
  );
});

test('previewRouteIndex and session pin preemption behave identically under expiry and drain strategies', () => {
  for (const strategy of ['expiry', 'drain']) {
    const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
      routingStrategy: strategy,
      weeklyBalanceMargin: 0.10,
      distributeSessions: true,
      expiryRouting: { enabled: strategy === 'expiry', preempt: strategy === 'expiry' },
    });
    am.currentIndex = 0;
    // Set large W gap that WOULD trigger balanced margin preemption
    bucket(am, 0, 'unified7d', 0.90, 50);
    bucket(am, 1, 'unified7d', 0.10, 50);

    // 1. previewRouteIndex ignores W gap under non-balanced strategies
    const preview = am.previewRouteIndex(OPUS);
    assert.equal(preview, 0, `previewRouteIndex must stay on current account under ${strategy} strategy`);
    assert.equal(am.currentIndex, 0);

    // 2. session pin ignores W gap under non-balanced strategies
    am.recordSession('s1', 0, OPUS);
    const selectedSession = am.getActiveAccount(null, OPUS, null, 's1');
    assert.equal(selectedSession.name, 'a', `session pin must remain on account a under ${strategy} strategy`);
  }
});

test('rollover preemption is gated on strategy === "expiry": inert under balanced, active under expiry', () => {
  const WEEK = 7 * 24 * H;

  // 1. _select under balanced: current account rolls over while ranking best.
  // Must NOT trigger rollover branch and must NOT log held-rollover spam.
  {
    const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
      routingStrategy: 'balanced',
      weeklyBalanceMargin: 0.10,
      expiryRouting: { enabled: true, preempt: true },
    });
    am.currentIndex = 0;
    bucket(am, 0, 'unified7d', 0.10, 10);
    bucket(am, 1, 'unified7d', 0.50, 10);

    // Initial serve to seed observation
    am.getActiveAccount(null, OPUS);

    // Roll window on account 0
    am.accounts[0].quota.unified7dReset += WEEK;

    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      const selected = am.getActiveAccount(null, OPUS);
      assert.equal(selected.name, 'a');
    } finally {
      console.log = origLog;
    }
    assert.equal(
      logs.some(l => l.includes('rolled over its unified7d window and still ranks best')),
      false,
      'under balanced, rolled-over current account must NOT log held-rollover message',
    );
  }

  // 2. _selectForSession under balanced: pinned account rolls over while ranking best.
  // Must NOT release session pin via rollover preemption.
  {
    const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
      routingStrategy: 'balanced',
      weeklyBalanceMargin: 0.10,
      distributeSessions: true,
      expiryRouting: { enabled: true, preempt: true },
    });
    am.currentIndex = 0;
    bucket(am, 0, 'unified7d', 0.10, 10);
    bucket(am, 1, 'unified7d', 0.50, 10);

    am.beginSession('s1');
    am.getActiveAccount(null, OPUS, null, 's1');
    am.recordSession('s1', 0, OPUS);
    am.endSession('s1');

    // Roll window on account 0
    am.accounts[0].quota.unified7dReset += WEEK;

    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    let selected;
    try {
      am.beginSession('s1');
      selected = am.getActiveAccount(null, OPUS, null, 's1');
      am.endSession('s1');
    } finally {
      console.log = origLog;
    }
    assert.equal(selected.name, 'a', 'session pin must stay on a under balanced');
    assert.equal(
      logs.some(l => l.includes('weekly window rolled over; re-routing')),
      false,
      'under balanced, rolled-over pin must NOT re-route via rollover preemption',
    );
  }

  // 3. previewRouteIndex under balanced: current account rolls over, but is within margin of best.
  // Must NOT treat current as rolled, returning current.index instead of re-ranking to best.
  {
    const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
      routingStrategy: 'balanced',
      weeklyBalanceMargin: 0.10,
      expiryRouting: { enabled: true, preempt: true },
    });
    am.currentIndex = 0;
    bucket(am, 0, 'unified7d', 0.25, 10);
    bucket(am, 1, 'unified7d', 0.20, 10); // diff 0.05 < margin 0.10 -> within margin

    am.getActiveAccount(null, OPUS);
    am.accounts[0].quota.unified7dReset += WEEK;

    const preview = am.previewRouteIndex(OPUS);
    assert.equal(
      preview,
      0,
      'previewRouteIndex under balanced must stay on current (index 0) within margin, ignoring rollover',
    );
  }

  // 4. Verification under expiry strategy: rollover preemption IS active.
  {
    const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
      routingStrategy: 'expiry',
      expiryRouting: { enabled: true, preempt: true },
    });
    am.currentIndex = 0;
    bucket(am, 0, 'unified7d', 0.40, 10);
    bucket(am, 1, 'unified7d', 0.40, 10);

    am.getActiveAccount(null, OPUS);
    am.accounts[0].quota.unified7dReset += WEEK;

    // Under expiry, a rolled over and b has earlier reset, so it switches to b
    const selected = am.getActiveAccount(null, OPUS);
    assert.equal(selected.name, 'b', 'under expiry strategy, rollover preemption must switch to b');
  }
});

// ---------------------------------------------------------------------------
// Task B (D6 [R1]): _pickLeastLoaded heldOff seam
// ---------------------------------------------------------------------------

test('_pickLeastLoaded under balanced: account exceeding margin above cheapest candidate is held off even with fewest sessions', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
    distributeSessions: true,
  });
  // a: W = 0.50, active sessions = 0
  // b: W = 0.20, active sessions = 2
  bucket(am, 0, 'unified7d', 0.50, 50);
  bucket(am, 1, 'unified7d', 0.20, 50);

  am.recordSession('s1', 1, OPUS);
  am.recordSession('s2', 1, OPUS);

  const now = Date.now();
  assert.equal(am.sessionTracker.activeCountFor(0, now), 0);
  assert.equal(am.sessionTracker.activeCountFor(1, now), 2);

  // heldOff check: a has W gap 0.30 >= 0.10 -> heldOff = 1.
  // b has W gap 0.00 < 0.10 -> heldOff = 0.
  // heldOff comes before sessions, so b (heldOff=0) beats a (heldOff=1) despite having more sessions.
  const picked = am._pickLeastLoaded(null, OPUS);
  assert.equal(picked.name, 'b', 'balanced heldOff beats session count: cheaper account with more sessions must win');
});

test('_pickLeastLoaded under balanced: accounts within margin are not held off and load decides among them', () => {
  const am = new AccountManager([oauth('b'), oauth('c')], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
    distributeSessions: true,
  });
  // b: W = 0.20, active sessions = 2
  // c: W = 0.25, active sessions = 1
  // W gap = 0.05 < margin 0.10 -> neither is held off (both heldOff = 0).
  bucket(am, 0, 'unified7d', 0.20, 50);
  bucket(am, 1, 'unified7d', 0.25, 50);

  am.recordSession('s1', 0, OPUS);
  am.recordSession('s2', 0, OPUS);
  am.recordSession('s3', 1, OPUS);

  const picked = am._pickLeastLoaded(null, OPUS);
  assert.equal(picked.name, 'c', 'within margin, neither account is held off and load (fewer sessions) decides');
});

test('_pickLeastLoaded min(W) is candidate-scoped: excluded cheaper account does not change candidate heldOff', () => {
  // Fleet of 3 accounts:
  // cheap: index 0, W = 0.05, active sessions = 0
  // med:   index 1, W = 0.14, active sessions = 2
  // high:  index 2, W = 0.16, active sessions = 1
  // margin = 0.10.
  //
  // Candidate set excludes cheap (index 0).
  // Over candidates {med, high}:
  // candidate min(W) = W(med) = 0.14.
  // med:  0.14 - 0.14 = 0.00 < 0.10 -> heldOff = 0.
  // high: 0.16 - 0.14 = 0.02 < 0.10 -> heldOff = 0.
  // Neither candidate is held off. Load decides: high has 1 session < med (2 sessions) -> high wins.
  //
  // (If min(W) were fleet-wide instead of candidate-scoped, min(W) = 0.05:
  //  med:  0.14 - 0.05 = 0.09 < 0.10 -> heldOff = 0.
  //  high: 0.16 - 0.05 = 0.11 >= 0.10 -> heldOff = 1.
  //  Then med would win due to false heldOff on high).
  const am = new AccountManager([oauth('cheap'), oauth('med'), oauth('high')], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
    distributeSessions: true,
  });
  bucket(am, 0, 'unified7d', 0.05, 50);
  bucket(am, 1, 'unified7d', 0.14, 50);
  bucket(am, 2, 'unified7d', 0.16, 50);

  am.recordSession('s1', 1, OPUS);
  am.recordSession('s2', 1, OPUS);
  am.recordSession('s3', 2, OPUS);

  const exclude = new Set([0]); // exclude cheap
  const picked = am._pickLeastLoaded(exclude, OPUS);
  assert.equal(
    picked.name,
    'high',
    'candidate-scoped min(W) ensures high is not held off; fewer sessions picks high',
  );
});

test('_belowBandFloor and _pickLeastLoaded preserve expiry strategy behaviour byte-for-byte', () => {
  const now = Date.now();
  const amExpiry = new AccountManager([oauth('a'), oauth('spent-noclock')], 0.98, {
    routingStrategy: 'expiry',
    weeklyBalanceMargin: 0.10,
    distributeSessions: true,
    expiryRouting: { enabled: true, tolerance: 1.5 },
  });
  bucket(amExpiry, 0, 'unified7d', 0.10, 10, now);
  const q = amExpiry.accounts[1].quota;
  q.unified7d = 0.95;
  q.unified7dReset = null; // no clock -> lowerBound is ~0.05 / (7 * 86400)
  amExpiry.accounts[1].probing = false;

  const spent = amExpiry._belowBandFloor(amExpiry.accounts, OPUS, now);
  assert.deepEqual(spent, [0, 1], 'expiry band floor holds off spent-noclock account based on expiry pressure');
});

// ---------------------------------------------------------------------------
// 11. Spec-review test coverage: W > 1.0 unclamped, advisor pass purity, Finding 1
// ---------------------------------------------------------------------------

test('W > 1.0 is not clamped end-to-end: flows through family-proxy, median, margin preemption, and belowBandFloor heldOff', () => {
  const now = Date.now();
  const am = new AccountManager([
    oauth('a'), // current, unified7dFable = 1.3 -> W = 1.3 (family-proxy)
    oauth('b'), // unprobed -> inherits median = 1.3
    oauth('c'), // unified7d = 0.95 -> W = 0.95 (unified)
  ], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
  });

  am.currentIndex = 0;
  // a: Fable spent beyond 1.0 (1.3 overage), but unified7d is null, so available for OPUS
  am.accounts[0].quota.unified7dFable = 1.3;
  am.accounts[0].quota.unified7dReset = now + 100 * H;
  am.accounts[0].probing = false;

  // b: unprobed (null quota)
  am.accounts[1].quota.unified7d = null;
  am.accounts[1].quota.unified7dReset = now + 100 * H;
  am.accounts[1].probing = false;

  // c: near cap (0.95), unified5h low (0.10)
  bucket(am, 2, 'unified7d', 0.95, 50, now);
  am.accounts[2].quota.unified5h = 0.10;

  // 1. _computeAllW preserves W > 1.0 for family-proxy and per-provider median
  // (Pass 1 resolved values: [1.3, 0.95]. Median of [0.95, 1.3] is (0.95 + 1.3) / 2 = 1.125 > 1.0)
  const Ws = am._computeAllW();
  assert.deepEqual(Ws[0], { value: 1.3, provenance: 'family-proxy' });
  assert.deepEqual(Ws[1], { value: 1.125, provenance: 'median' });
  assert.deepEqual(Ws[2], { value: 0.95, provenance: 'unified' });

  // 2. Also check fleet of two [a, b] where median is exactly 1.3
  const amTwo = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
  });
  amTwo.accounts[0].quota.unified7dFable = 1.3;
  const WsTwo = amTwo._computeAllW();
  assert.deepEqual(WsTwo[0], { value: 1.3, provenance: 'family-proxy' });
  assert.deepEqual(WsTwo[1], { value: 1.3, provenance: 'median' });

  // 3. _marginPreemptedBy: unclamped W diff is 1.3 - 0.95 = 0.35 >= 0.10 -> preempts to c.
  // If W were clamped to 1.0, 1.0 - 0.95 = 0.05 < 0.10 and preemption would NOT fire.
  assert.equal(am._isAvailable(am.accounts[0], OPUS), true, 'account a is available for OPUS');
  assert.equal(am._isAvailable(am.accounts[2], OPUS), true, 'account c is available for OPUS');
  const preemptor = am._marginPreemptedBy(am.accounts[0], OPUS);
  assert.equal(preemptor?.name, 'c', '_marginPreemptedBy must preempt to c because 1.3 - 0.95 >= 0.10');

  const selected = am.getActiveAccount(null, OPUS);
  assert.equal(selected.name, 'c', 'selection must switch to c on unclamped margin');
  assert.equal(am.currentIndex, 2);

  // 4. _belowBandFloor: W > 1.0 reaches heldOff seam for both family-proxy and median
  // For [a, c]: a (1.3) vs c (0.95) -> diff 0.35 >= 0.10 -> [1, 0]
  // (If clamped to 1.0, diff 0.05 < 0.10 -> [0, 0])
  const heldOffDirect = am._belowBandFloor([am.accounts[0], am.accounts[2]], OPUS, now);
  assert.deepEqual(heldOffDirect, [1, 0], 'candidate with family-proxy W = 1.3 is held off against W = 0.95');

  // For [b, c]: b (median 1.125) vs c (0.95) -> diff 0.175 >= 0.10 -> [1, 0]
  // (If clamped to 1.0, diff 0.05 < 0.10 -> [0, 0])
  const heldOffMedian = am._belowBandFloor([am.accounts[1], am.accounts[2]], OPUS, now);
  assert.deepEqual(heldOffMedian, [1, 0], 'candidate with median W = 1.125 is held off against W = 0.95');

  // For two-account fleet [a, b] with candidate c: b has median 1.3
  const heldOffExactMedian = amTwo._belowBandFloor([amTwo.accounts[1], am.accounts[2]], OPUS, now);
  assert.deepEqual(heldOffExactMedian, [1, 0], 'candidate with median W = 1.3 is held off against W = 0.95');
});

test('advisor pass never mutates under balanced routing: does not move cursor, seed observations, or increment marginMove counters', () => {
  // Case 1: An advisor request degrades to executor-only when no account can serve the advisor model.
  // Neither account can serve Fable. Account a has lower W (0.20) than b (0.25), diff < margin.
  {
    const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
      routingStrategy: 'balanced',
      weeklyBalanceMargin: 0.10,
    });
    am.currentIndex = 0;
    bucket(am, 0, 'unified7d', 0.20, 50);
    bucket(am, 0, 'unified7dFable', 1.0, 50); // Fable spent
    bucket(am, 1, 'unified7d', 0.25, 50);
    bucket(am, 1, 'unified7dFable', 1.0, 50); // Fable spent

    const initialCounters = { ...am.marginMove };
    assert.equal(am._currentObs, null);

    // Direct check of advisor-constrained pass in isolation:
    const pass1 = am._select(null, OPUS, FABLE, false);
    assert.equal(pass1, null, 'pass 1 returns null when no account satisfies advisor model');
    assert.equal(am.currentIndex, 0, 'pass 1 must not move currentIndex');
    assert.equal(am._currentObs, null, 'pass 1 must not seed _currentObs');
    assert.deepEqual(am.marginMove, initialCounters, 'pass 1 must not increment marginMove counters');

    // Full selection degrading to executor-only:
    const chosen = am.getActiveAccount(null, OPUS, FABLE);
    assert.equal(chosen.name, 'a', 'degrades to executor-only returning account a');
    assert.equal(am.currentIndex, 0, 'cursor must stay on account a');
    assert.equal(am._currentObs, null, '_currentObs must not be seeded on b');
    assert.equal(am.marginMove.done, 0, 'marginMove.done must not increment');
  }

  // Case 2: Off-pointer advisor serving (fork test 5 shape).
  // Current account a cannot serve Fable; account b can.
  // W(a) = 0.20, W(b) = 0.10 (diff = 0.10 >= margin 0.10).
  {
    const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
      routingStrategy: 'balanced',
      weeklyBalanceMargin: 0.10,
    });
    am.currentIndex = 0;
    bucket(am, 0, 'unified7d', 0.20, 50);
    bucket(am, 0, 'unified7dFable', 1.0, 50); // a cannot serve Fable advisor
    bucket(am, 1, 'unified7d', 0.10, 50);
    bucket(am, 1, 'unified7dFable', 0.10, 50); // b can serve Fable advisor

    const initialCounters = { ...am.marginMove };

    const acc = am.getActiveAccount(null, OPUS, FABLE);
    assert.equal(acc.name, 'b', 'account b serves the advisor request');
    assert.equal(am.currentIndex, 0, 'advisor pass is read-only on cursor; currentIndex untouched');
    assert.equal(am._currentObs, null, 'off-pointer advisor serving must not seed _currentObs');
    assert.equal(am.marginMove.done, 0, 'off-pointer advisor serving must not count as marginMove.done');
    assert.deepEqual(am.marginMove, initialCounters, 'marginMove counters untouched by off-pointer advisor serving');
  }

  // Case 3: Session affinity advisor pass (_selectForSession).
  // Pinned account evaluated against advisorModel under balanced.
  {
    const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
      routingStrategy: 'balanced',
      weeklyBalanceMargin: 0.10,
      distributeSessions: true,
    });
    bucket(am, 0, 'unified7d', 0.20, 50);
    bucket(am, 1, 'unified7d', 0.10, 50);
    am.recordSession('s1', 0, OPUS);

    const countersBefore = { ...am.marginMove };
    am._selectForSession('s1', null, OPUS, FABLE);
    assert.deepEqual(am.marginMove, countersBefore, '_selectForSession must pass count: false and not mutate marginMove counters');
  }
});

test('Finding 1 regression: family-gated request does not rank-move cursor away from priority winner', () => {
  const am = new AccountManager([
    oauth('a', { priority: 0 }),
    oauth('b', { priority: 1 }),
  ], 0.98, {
    routingStrategy: 'balanced',
    weeklyBalanceMargin: 0.10,
  });
  am.currentIndex = 0;
  bucket(am, 0, 'unified7d', 0.50, 50);
  bucket(am, 0, 'unified7dFable', 1.0, 50); // a is Fable-gated, but Opus is fine
  bucket(am, 1, 'unified7d', 0.30, 50);
  bucket(am, 1, 'unified7dFable', 0.30, 50); // b can serve both, lower W, but priority 1

  // 1. Initial state check: account a is priority winner, available for OPUS but barred for FABLE
  assert.equal(am.currentIndex, 0);
  assert.equal(am._isAvailable(am.accounts[0], OPUS), true);
  assert.equal(am._isAvailable(am.accounts[0], FABLE), false);
  assert.equal(am._currentBarredOnlyFor(FABLE), true);

  // 2. Interleaved requests across models: FABLE must divert to b, OPUS must stay on a,
  // and cursor (currentIndex) must NEVER move away from priority winner a.
  let pointerSwitches = 0;
  let lastPointer = am.currentIndex;

  for (let i = 0; i < 6; i++) {
    const model = (i % 2 === 0) ? FABLE : OPUS;
    const chosen = am.getActiveAccount(null, model);
    if (model === FABLE) {
      assert.equal(chosen.name, 'b', `request ${i} (FABLE) must divert to account b`);
    } else {
      assert.equal(chosen.name, 'a', `request ${i} (OPUS) must be served by priority winner a`);
    }
    if (am.currentIndex !== lastPointer) {
      pointerSwitches++;
      lastPointer = am.currentIndex;
    }
  }

  assert.equal(pointerSwitches, 0, 'cursor must never move away from priority winner');
  assert.equal(am.currentIndex, 0, 'currentIndex must remain 0');
});




