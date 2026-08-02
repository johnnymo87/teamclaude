import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

const OPUS = 'claude-opus-4-6';
const FABLE = 'claude-fable-5';

test('1. unified7d = 1.00, unified7dFable = 0.20 -> NOT available for Fable (governingWeekly returns max 1.00)', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const account = am.accounts[0];
  account.quota.unified5h = 0.1;
  account.quota.unified7d = 1.00;
  account.quota.unified7dFable = 0.20;

  assert.equal(am._governingWeekly(account, FABLE), 1.00);
  assert.equal(am._isAvailable(account, FABLE), false, 'account must not be available for Fable when unified7d is spent');
});

test('2. unified7d = 0.20, unified7dFable = 1.00 -> NOT available for Fable, but IS available for Opus', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const account = am.accounts[0];
  account.quota.unified5h = 0.1;
  account.quota.unified7d = 0.20;
  account.quota.unified7dFable = 1.00;

  assert.equal(am._governingWeekly(account, FABLE), 1.00);
  assert.equal(am._isAvailable(account, FABLE), false, 'account must not be available for Fable when Fable bucket is spent');
  assert.equal(am._governingWeekly(account, OPUS), 0.20);
  assert.equal(am._isAvailable(account, OPUS), true, 'account must still be available for Opus');
});

test('3. both buckets low -> available for both Fable and Opus', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const account = am.accounts[0];
  account.quota.unified5h = 0.1;
  account.quota.unified7d = 0.20;
  account.quota.unified7dFable = 0.30;

  assert.equal(am._governingWeekly(account, FABLE), 0.30);
  assert.equal(am._isAvailable(account, FABLE), true);
  assert.equal(am._governingWeekly(account, OPUS), 0.20);
  assert.equal(am._isAvailable(account, OPUS), true);
});

test('4. unified7dFable reported but unified7d null -> falls back to family value alone', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const account = am.accounts[0];
  account.quota.unified5h = 0.1;
  account.quota.unified7d = null;
  account.quota.unified7dFable = 0.50;

  assert.equal(am._governingWeekly(account, FABLE), 0.50);
  assert.equal(am._isAvailable(account, FABLE), true);

  account.quota.unified7dFable = 1.00;
  assert.equal(am._governingWeekly(account, FABLE), 1.00);
  assert.equal(am._isAvailable(account, FABLE), false);
});

test('5. both null -> _governingWeekly returns null and does not gate', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const account = am.accounts[0];
  account.quota.unified5h = 0.1;
  account.quota.unified7d = null;
  account.quota.unified7dFable = null;

  assert.equal(am._governingWeekly(account, FABLE), null);
  assert.equal(am._governingWeekly(account, OPUS), null);
  assert.equal(am._isAvailable(account, FABLE), true);
  assert.equal(am._isAvailable(account, OPUS), true);
});

test('6. model whose governing bucket is unified7d behaves as before', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const account = am.accounts[0];
  account.quota.unified5h = 0.1;
  account.quota.unified7d = 0.40;

  assert.equal(am._governingWeekly(account, OPUS), 0.40);
  assert.equal(am._isAvailable(account, OPUS), true);

  account.quota.unified7d = 1.00;
  assert.equal(am._governingWeekly(account, OPUS), 1.00);
  assert.equal(am._isAvailable(account, OPUS), false);

  account.quota.unified7d = null;
  assert.equal(am._governingWeekly(account, OPUS), null);
  assert.equal(am._isAvailable(account, OPUS), true);
});
