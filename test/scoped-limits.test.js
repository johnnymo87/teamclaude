import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const oauth = (name, extra = {}) => ({ name, type: 'oauth', accessToken: 't-' + name, expiresAt: Date.now() + 3600_000, ...extra });

test('applyUsageData stores scopedLimits and round-trips through persistence', () => {
  const am = new AccountManager([oauth('a', { accountUuid: 'p1' })], 0.98);
  am.applyUsageData(0, {
    sevenDay: { utilization: 0.4, resetAt: 222 },
    scopedLimits: { opus: { utilization: 0.96, resetAt: 999, severity: 'high', isActive: true } },
  });
  assert.equal(am.accounts[0].quota.scopedLimits.opus.isActive, true);

  const am2 = new AccountManager([oauth('a', { accountUuid: 'p1' })], 0.98);
  am2.restoreQuotaState(am.exportQuotaState());
  assert.equal(am2.accounts[0].quota.scopedLimits.opus.utilization, 0.96);
  assert.equal(am2.accounts[0].quota.scopedLimits.opus.resetAt, 999);
});

test('applyUsageData with no scopedLimits leaves the map untouched', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  am.applyUsageData(0, { scopedLimits: { sonnet: { utilization: 0.1, resetAt: 1, severity: 'normal', isActive: false } } });
  am.applyUsageData(0, { sevenDay: { utilization: 0.2, resetAt: 2 } }); // probe w/o limits[]
  assert.equal(am.accounts[0].quota.scopedLimits.sonnet.utilization, 0.1);
});

test('_clearExpiredQuotas drops a scoped entry whose reset passed', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  am.applyUsageData(0, { scopedLimits: {
    opus:   { utilization: 1, resetAt: Date.now() - 1000, severity: 'high', isActive: true },
    sonnet: { utilization: 0.1, resetAt: Date.now() + 3600_000, severity: 'normal', isActive: false },
  }});
  am._clearExpiredQuotas(am.accounts[0]);
  assert.equal(am.accounts[0].quota.scopedLimits.opus, undefined);   // expired → removed
  assert.ok(am.accounts[0].quota.scopedLimits.sonnet);               // future → kept
});
