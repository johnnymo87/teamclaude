import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';

/**
 * accounts[].maxDailySpend: a per-account cap on money billed per local
 * calendar day, in the currency's major unit (100 = $100.00). It exists for
 * money-metered seats (Claude Enterprise `enterprise_usage_based`), which have
 * no quota buckets for maxUsage to cap. Spend is learned from the zero-cost
 * usage probe's month-to-date `spend.used`, so the day's figure is the sum of
 * increases between probe readings since local midnight.
 */

const ENTERPRISE = { organizationType: 'claude_enterprise', rateLimitTier: 'default_claude_zero', seatTier: 'enterprise_usage_based' };

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}
function spend(usedMinor, extra = {}) {
  return { spend: { enabled: true, usedMinor, limitMinor: null, currency: 'USD', exponent: 2, userDisabled: false, disabledReason: null, ...extra } };
}
function fleet(maxDailySpend) {
  const am = new AccountManager([oauth('max'), oauth('ent', { ...ENTERPRISE, maxDailySpend })], 0.98);
  am.accounts[0].quota.unified5h = 0.1;
  am.accounts[0].quota.unified7d = 0.2;
  return am;
}
// Local-time instants, so the day boundary under test is the process's own.
const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

function withClock(t, fn) {
  mock.timers.enable({ apis: ['Date'], now: t });
  try { return fn((next) => mock.timers.setTime(next)); } finally { mock.timers.reset(); }
}

test('the first reading is a baseline: spend before tracking began is not attributed to today', () => {
  withClock(at(2026, 11, 3, 9), () => {
    const am = fleet(100);
    am.applyUsageData(1, spend(50_00));
    assert.equal(am.dailySpendMinor(am.accounts[1]), 0);
    assert.equal(am.unavailableReason(am.accounts[1]), null);
  });
});

test('increases between readings accumulate; the cap bars the account once reached', () => {
  withClock(at(2026, 11, 3, 9), (set) => {
    const am = fleet(100);
    am.applyUsageData(1, spend(50_00));
    set(at(2026, 11, 3, 10)); am.applyUsageData(1, spend(110_00));
    assert.equal(am.dailySpendMinor(am.accounts[1]), 60_00);
    assert.equal(am.unavailableReason(am.accounts[1]), null);
    set(at(2026, 11, 3, 11)); am.applyUsageData(1, spend(150_00));
    assert.equal(am.dailySpendMinor(am.accounts[1]), 100_00);
    assert.equal(am.unavailableReason(am.accounts[1]), 'spend-capped');
  });
});

test('a capped seat is skipped even by the all-unavailable probe path (hard cap, like maxUsage)', () => {
  withClock(at(2026, 11, 3, 9), (set) => {
    const am = fleet(10);
    am.applyUsageData(1, spend(0));
    set(at(2026, 11, 3, 10)); am.applyUsageData(1, spend(10_00));
    am.accounts[0].quota.unified5h = 0.99; // the Max account is unavailable too
    assert.ok(am.capExceeded(am.accounts[1]));
    const probe = am._selectProbe();
    assert.notEqual(probe?.name, 'ent', 'an operator budget is not overridden by "everything else is spent"');
  });
});

test('local midnight resets the day; the cap lifts without waiting for a probe', () => {
  withClock(at(2026, 11, 3, 23, 50), (set) => {
    const am = fleet(10);
    am.applyUsageData(1, spend(0));
    set(at(2026, 11, 3, 23, 55)); am.applyUsageData(1, spend(12_00));
    assert.equal(am.unavailableReason(am.accounts[1]), 'spend-capped');
    set(at(2026, 11, 4, 0, 1));
    assert.equal(am.dailySpendMinor(am.accounts[1]), 0, 'a new day starts at zero');
    assert.equal(am.unavailableReason(am.accounts[1]), null);
    set(at(2026, 11, 4, 0, 6)); am.applyUsageData(1, spend(13_00));
    assert.equal(am.dailySpendMinor(am.accounts[1]), 1_00, 'only the increase after midnight counts toward the new day');
  });
});

test('a month-to-date reset (new billing month) counts the new month\'s spend, never a negative', () => {
  withClock(at(2026, 11, 30, 23), (set) => {
    const am = fleet(100);
    am.applyUsageData(1, spend(900_00));
    set(at(2026, 12, 1, 0, 5)); am.applyUsageData(1, spend(3_00));
    assert.equal(am.dailySpendMinor(am.accounts[1]), 3_00);
  });
});

test('no cap configured: spend is tracked but never bars the account', () => {
  withClock(at(2026, 11, 3, 9), (set) => {
    const am = fleet(undefined);
    am.applyUsageData(1, spend(0));
    set(at(2026, 11, 3, 10)); am.applyUsageData(1, spend(5000_00));
    assert.equal(am.dailySpendMinor(am.accounts[1]), 5000_00);
    assert.equal(am.unavailableReason(am.accounts[1]), null);
  });
});

test('invalid caps are ignored rather than barring the account', () => {
  for (const bad of [0, -5, 'lots', NaN, null]) {
    const am = fleet(bad);
    assert.equal(am.accounts[1].maxDailySpend, null, String(bad));
  }
  assert.equal(fleet('25').accounts[1].maxDailySpend, null, 'a string is not a number');
  assert.equal(fleet(33.5).accounts[1].maxDailySpend, 33.5);
});

test('the day\'s tracker survives a restart, so spend while the daemon was down still counts', () => {
  withClock(at(2026, 11, 3, 9), (set) => {
    const am = fleet(100);
    am.applyUsageData(1, spend(10_00));
    set(at(2026, 11, 3, 10)); am.applyUsageData(1, spend(40_00));
    const saved = JSON.parse(JSON.stringify(am.exportQuotaState()));

    const am2 = fleet(100);
    am2.restoreQuotaState(saved);
    assert.equal(am2.dailySpendMinor(am2.accounts[1]), 30_00);
    set(at(2026, 11, 3, 12)); am2.applyUsageData(1, spend(120_00));
    assert.equal(am2.dailySpendMinor(am2.accounts[1]), 110_00);
    assert.equal(am2.unavailableReason(am2.accounts[1]), 'spend-capped');
  });
});

test('status exposes the cap and today\'s spend', () => {
  withClock(at(2026, 11, 3, 9), (set) => {
    const am = fleet(100);
    am.applyUsageData(1, spend(0));
    set(at(2026, 11, 3, 10)); am.applyUsageData(1, spend(25_50));
    const row = am.getStatus().accounts[1];
    assert.equal(row.maxDailySpend, 100);
    assert.equal(row.dailySpend.spentMinor, 25_50);
  });
});

test('a disk edit of maxDailySpend applies on reload, and removing it uncaps', async () => {
  const am = fleet(10);
  const memConfig = { accounts: [{ name: 'max', type: 'oauth' }, { name: 'ent', type: 'oauth', maxDailySpend: 10 }] };
  const disk = (v) => ({ accounts: [
    { ...oauth('max'), id: am.accounts[0].id },
    { ...oauth('ent', { ...ENTERPRISE }), id: am.accounts[1].id, ...(v === undefined ? {} : { maxDailySpend: v }) },
  ] });
  await syncAccountsFromDisk(disk(50), memConfig, am);
  assert.equal(am.accounts[1].maxDailySpend, 50);
  await syncAccountsFromDisk(disk(undefined), memConfig, am);
  assert.equal(am.accounts[1].maxDailySpend, null);
});

test('the Spend line shows today against the cap, and the unavailable reason names it', async () => {
  const { spendLine, UNAVAILABLE_TEXT } = await import('../src/status-renderer.js');
  const paint = new Proxy({}, { get: () => (v) => String(v) });
  const row = {
    quota: { spend: { enabled: true, usedMinor: 40_00, limitMinor: null, currency: 'USD', exponent: 2 } },
    dailySpend: { day: '2026-11-03', spentMinor: 12_34, exponent: 2 },
    maxDailySpend: 33,
  };
  assert.match(spendLine(row, paint), /today \$12\.34 of \$33\.00 cap/);
  assert.match(spendLine({ ...row, maxDailySpend: null }, paint), /today \$12\.34$/);
  assert.doesNotMatch(spendLine({ ...row, dailySpend: null }, paint), /today/);
  assert.match(UNAVAILABLE_TEXT['spend-capped'], /maxDailySpend/);
});

test('fails CLOSED when spend readings stop: no reading for 20 minutes bars a capped seat', () => {
  withClock(at(2026, 11, 3, 9), (set) => {
    const am = fleet(100);
    am.applyUsageData(1, spend(0));
    set(at(2026, 11, 3, 9, 19));
    assert.equal(am.unavailableReason(am.accounts[1]), null);
    set(at(2026, 11, 3, 9, 21));
    assert.equal(am.unavailableReason(am.accounts[1]), 'spend-unknown',
      'a money cap that can no longer see spend must not keep spending');
    am.applyUsageData(1, spend(1_00));
    assert.equal(am.unavailableReason(am.accounts[1]), null, 'the next reading restores it');
  });
});

test('a capped seat with no reading yet is held until its first probe; an uncapped one is not', () => {
  const capped = fleet(100);
  assert.equal(capped.unavailableReason(capped.accounts[1]), 'spend-unknown');
  const uncapped = fleet(undefined);
  assert.equal(uncapped.unavailableReason(uncapped.accounts[1]), null);
});

test('a small downward revision mid-month re-baselines instead of reading as a new month', () => {
  withClock(at(2026, 11, 20, 9), (set) => {
    const am = fleet(100);
    am.applyUsageData(1, spend(900_00));
    set(at(2026, 11, 20, 9, 5)); am.applyUsageData(1, spend(899_99));
    assert.equal(am.dailySpendMinor(am.accounts[1]), 0);
    assert.equal(am.unavailableReason(am.accounts[1]), null);
    set(at(2026, 11, 20, 9, 10)); am.applyUsageData(1, spend(902_00));
    assert.equal(am.dailySpendMinor(am.accounts[1]), 2_01, 'measured from the revised reading');
  });
});

test('a drop to below half the previous reading is a rollover even within a calendar month', () => {
  // Billing months need not align with calendar months.
  withClock(at(2026, 11, 14, 9), (set) => {
    const am = fleet(100);
    am.applyUsageData(1, spend(800_00));
    set(at(2026, 11, 14, 9, 5)); am.applyUsageData(1, spend(2_00));
    assert.equal(am.dailySpendMinor(am.accounts[1]), 2_00);
  });
});
