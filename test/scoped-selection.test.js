import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const oauth = (name, extra = {}) => ({ name, type: 'oauth', accessToken: 't-' + name, expiresAt: Date.now() + 3600_000, ...extra });
const future = () => Date.now() + 3600_000;

test('_isNearQuota(acct,"opus") trips on an active opus scope while unified is low', () => {
  const am = new AccountManager([oauth('a')], 0.98, 0.90);
  const a = am.accounts[0];
  a.quota.unified5h = 0.10; a.quota.unified7d = 0.10;
  a.quota.scopedLimits = { opus: { utilization: 0.95, resetAt: future(), severity: 'normal', isActive: true } };
  assert.equal(am._isNearQuota(a), false);          // class-free: unified low → fine
  assert.equal(am._isNearQuota(a, 'opus'), true);   // opus: 0.95 ≥ 0.90 scoped threshold
  assert.equal(am._isNearQuota(a, 'sonnet'), false);// other class unaffected
});

test('severity alone (any non-normal) trips even below the scoped threshold', () => {
  const am = new AccountManager([oauth('a')], 0.98, 0.90);
  const a = am.accounts[0];
  a.quota.scopedLimits = { opus: { utilization: 0.10, resetAt: future(), severity: 'warning', isActive: true } };
  assert.equal(am._isNearQuota(a, 'opus'), true);
});

test('an INACTIVE scope never gates', () => {
  const am = new AccountManager([oauth('a')], 0.98, 0.90);
  const a = am.accounts[0];
  a.quota.scopedLimits = { opus: { utilization: 1, resetAt: future(), severity: 'high', isActive: false } };
  assert.equal(am._isNearQuota(a, 'opus'), false);
});

test('_pickBestAvailable(class) skips the account constrained for that class', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, 0.90);
  const [a, b] = am.accounts;
  a.quota.unified7dReset = Date.now() + 86_400_000;          // known weekly → available
  b.quota.unified7dReset = Date.now() + 2 * 86_400_000;
  a.quota.scopedLimits = { opus: { utilization: 0.99, resetAt: Date.now() + 3600_000, severity: 'normal', isActive: true } };
  assert.equal(am._pickBestAvailable('opus').name, 'b');     // a is opus-near → pick b
  assert.equal(am._pickBestAvailable('sonnet').name, 'a');   // sonnet unconstrained → a (sooner reset)
  assert.equal(am._pickBestAvailable().name, 'a');           // class-free unchanged
});
