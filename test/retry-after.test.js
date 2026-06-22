import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const oauth = (name) => ({ name, type: 'oauth', accessToken: 't', expiresAt: Date.now() + 3600_000 });

test('_soonestResetMs takes the min across all reset fields incl scoped', () => {
  const am = new AccountManager([oauth('a')], 0.98, 0.90);
  const a = am.accounts[0];
  const t = Date.now();
  a.quota.unified5hReset = t + 50_000;
  a.quota.unified7dReset = t + 90_000;
  a.quota.scopedLimits = { opus: { utilization: 1, resetAt: t + 20_000, severity: 'high', isActive: true } };
  assert.equal(am._soonestResetMs(a), t + 20_000);   // scoped is soonest
});

test('[R2] a throttled account with a stale quota reset is NOT reactivated early', () => {
  const am = new AccountManager([oauth('a')], 0.98, 0.90);
  const a = am.accounts[0];
  a.status = 'throttled';
  a.rateLimitedUntil = Date.now() + 60_000;        // throttle still active
  a.quota.unified7dReset = Date.now() - 1000;      // stale reset in another field
  const picked = am._selectNext();                 // all unavailable → fallback
  assert.equal(picked, null);                      // must NOT reactivate before throttle
  assert.equal(a.status, 'throttled');
});

