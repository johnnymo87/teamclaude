import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

test('getStatus surfaces scopedLimits for each account', () => {
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 't', expiresAt: Date.now() + 1e7 }], 0.98, 0.90);
  am.accounts[0].quota.scopedLimits = { opus: { utilization: 0.5, resetAt: 1, severity: 'normal', isActive: true } };
  const st = am.getStatus();
  assert.equal(st.accounts[0].quota.scopedLimits.opus.utilization, 0.5);
});
