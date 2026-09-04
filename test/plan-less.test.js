import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

/**
 * A lapsed Max subscription keeps its OAuth grant: the account authenticates,
 * reports status=active, and returns NO quota at all. Because _isNearQuota only
 * gates on buckets that are REPORTED, such an account was never gated and stayed
 * selectable forever. Observed on a real fleet 2026-08-28..09-04.
 */
function planLess(am, i, probes = 3) {
  // Drive it the way the daemon does: repeated silent probes. Setting the quota
  // fields directly would test a state the running system can only reach THROUGH
  // applyUsageData, and would skip the sustained-ness requirement entirely.
  for (let n = 0; n < probes; n++) {
    am.applyUsageData(i, { fiveHour: { utilization: 0 } });
  }
}
function healthy(am, i, u5h = 0.1, u7d = 0.2) {
  am.accounts[i].quota.unified5h = u5h;
  am.accounts[i].quota.unified7d = u7d;
}

test('a plan-less account is unavailable while a reporting sibling exists', () => {
  const am = new AccountManager([oauth('dead'), oauth('live')]);
  planLess(am, 0);
  healthy(am, 1);
  assert.equal(am._isAvailable(am.accounts[0]), false, 'plan-less account must not be selectable');
  assert.equal(am._isAvailable(am.accounts[1]), true);
});

test('when NOTHING reports, no account is excluded (probe has not run, or upstream outage)', () => {
  const am = new AccountManager([oauth('a'), oauth('b')]);
  planLess(am, 0);
  planLess(am, 1);
  assert.equal(am._isAvailable(am.accounts[0]), true, 'an unprobed fleet must not be emptied');
  assert.equal(am._isAvailable(am.accounts[1]), true);
});

test('reported ZEROS are not plan-less — a freshly reset account still serves', () => {
  const am = new AccountManager([oauth('fresh'), oauth('live')]);
  am.accounts[0].quota.unified5h = 0;
  am.accounts[0].quota.unified7d = 0;
  am.accounts[0].quota.unified7dFable = 0;
  healthy(am, 1);
  assert.equal(am._isAvailable(am.accounts[0]), true);
});

test('null weeklies with a live family bucket are not plan-less (the johnnymo872 July case)', () => {
  const am = new AccountManager([oauth('partial'), oauth('live')]);
  am.accounts[0].quota.unified5h = 0;
  am.accounts[0].quota.unified7d = null;
  am.accounts[0].quota.unified7dFable = 0.26;
  healthy(am, 1);
  assert.equal(am._isAvailable(am.accounts[0]), true,
    'unreported unified7d alone must not condemn an account; this ran for ~1620 samples on a healthy one');
});

test('5h consumption proves a plan exists even with both weeklies unreported', () => {
  const am = new AccountManager([oauth('serving'), oauth('live')]);
  am.accounts[0].quota.unified5h = 0.4;
  am.accounts[0].quota.unified7d = null;
  am.accounts[0].quota.unified7dFable = null;
  healthy(am, 1);
  assert.equal(am._isAvailable(am.accounts[0]), true);
});

test('exclusion is soft: the all-exhausted probe path can still reach a plan-less account', () => {
  const am = new AccountManager([oauth('dead'), oauth('spent')]);
  planLess(am, 0);
  am.accounts[1].quota.unified5h = 0.99; // over threshold, unavailable
  assert.equal(am._isAvailable(am.accounts[0]), false);
  assert.equal(am._isAvailable(am.accounts[1]), false);
  const probe = am._selectProbe();
  assert.ok(probe, 'a fleet with nothing available must still yield a probe target');
});

test('a never-probed account is not plan-less, however silent (freshly added, or just restarted)', () => {
  const am = new AccountManager([oauth('brandnew'), oauth('live')]);
  healthy(am, 1);
  // brandnew has never been probed: quota is empty because nothing has looked yet.
  assert.equal(am.accounts[0].silentProbes || 0, 0);
  assert.equal(am._isAvailable(am.accounts[0]), true,
    'excluding an unprobed account would black-hole every newly added one');
});

test('one silent probe is not enough; the third condemns it', () => {
  const am = new AccountManager([oauth('dead'), oauth('live')]);
  healthy(am, 1);
  am.applyUsageData(0, { fiveHour: { utilization: 0 } });
  assert.equal(am._isAvailable(am.accounts[0]), true, 'one silent probe must not condemn');
  am.applyUsageData(0, { fiveHour: { utilization: 0 } });
  assert.equal(am._isAvailable(am.accounts[0]), true, 'two must not either');
  am.applyUsageData(0, { fiveHour: { utilization: 0 } });
  assert.equal(am._isAvailable(am.accounts[0]), false, 'the third is the threshold');
});

test('a single reporting probe rehabilitates an account immediately', () => {
  const am = new AccountManager([oauth('resub'), oauth('live')]);
  healthy(am, 1);
  planLess(am, 0);
  assert.equal(am._isAvailable(am.accounts[0]), false);
  am.applyUsageData(0, { sevenDay: { utilization: 0.05 } });
  assert.equal(am._isAvailable(am.accounts[0]), true, 'resubscribing must not need three probes to take effect');
});
