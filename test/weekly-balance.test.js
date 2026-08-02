import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { createDefaultConfig } from '../src/config.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

test('default config specifies drain strategy and 0.10 margin', () => {
  const cfg = createDefaultConfig();
  assert.equal(cfg.routingStrategy, 'drain');
  assert.equal(cfg.weeklyBalanceMargin, 0.10);
});

test('AccountManager initializes routingStrategy and weeklyBalanceMargin options', () => {
  const amDefault = new AccountManager([oauth('a')]);
  assert.equal(amDefault.routingStrategy, 'drain');
  assert.equal(amDefault.weeklyBalanceMargin, 0.10);

  const amBalanced = new AccountManager([oauth('a')], 0.98, { routingStrategy: 'balanced', weeklyBalanceMargin: 0.15 });
  assert.equal(amBalanced.routingStrategy, 'balanced');
  assert.equal(amBalanced.weeklyBalanceMargin, 0.15);
});

test('W computation pass 1: unified provenance and family-proxy provenance', () => {
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98, { routingStrategy: 'balanced' });
  am.accounts[0].quota.unified7d = 0.4;
  am.accounts[1].quota.unified7dFable = 0.6;
  am.accounts[1].quota.unified7dSonnet = 0.8; // max is 0.8
  // am.accounts[2] is null

  const Ws = am._computeAllW();
  assert.deepEqual(Ws[0], { value: 0.4, provenance: 'unified' });
  assert.deepEqual(Ws[1], { value: 0.8, provenance: 'family-proxy' });
  // Median of pass 1 resolved [0.4, 0.8] is 0.6
  assert.equal(Ws[2].provenance, 'median');
  assert.ok(Math.abs(Ws[2].value - 0.6) < 1e-9);
});

test('W computation pass 2: all null fleet yields 0 empty', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, { routingStrategy: 'balanced' });
  const Ws = am._computeAllW();
  assert.deepEqual(Ws[0], { value: 0, provenance: 'empty' });
  assert.deepEqual(Ws[1], { value: 0, provenance: 'empty' });
});

test('W computation tolerates W > 1.0 without clamping', () => {
  const am = new AccountManager([oauth('a')], 0.98, { routingStrategy: 'balanced' });
  am.accounts[0].quota.unified7dFable = 1.3;
  const Ws = am._computeAllW();
  assert.deepEqual(Ws[0], { value: 1.3, provenance: 'family-proxy' });
});

const OPUS = 'claude-opus-4-6';
const FABLE = 'claude-fable-5';

test('1. Ranking order: lowest W wins under balanced; drain unchanged with same fixtures', () => {
  // Balanced mode: account b has lower W (0.2) than a (0.5), so b is selected on startup/getActiveAccount.
  const amBalanced = new AccountManager([oauth('a'), oauth('b')], 0.98, { routingStrategy: 'balanced' });
  amBalanced.accounts[0].quota.unified7d = 0.5;
  amBalanced.accounts[1].quota.unified7d = 0.2;
  assert.equal(amBalanced.selectActiveAccount().name, 'b');

  // Drain mode: drain strategy picks first available (account a)
  const amDrain = new AccountManager([oauth('a'), oauth('b')], 0.98, { routingStrategy: 'drain' });
  amDrain.accounts[0].quota.unified7d = 0.5;
  amDrain.accounts[1].quota.unified7d = 0.2;
  assert.equal(amDrain.selectActiveAccount().name, 'a');
});

test('2. Margin gate: W difference just under margin does NOT switch; just over DOES', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, { routingStrategy: 'balanced', weeklyBalanceMargin: 0.10 });
  am.currentIndex = 0;
  am.accounts[0].quota.unified7d = 0.35;
  am.accounts[1].quota.unified7d = 0.26; // diff = 0.09 < 0.10 -> no switch

  let selected = am.getActiveAccount();
  assert.equal(selected.name, 'a');
  assert.equal(am.currentIndex, 0);

  am.accounts[1].quota.unified7d = 0.24; // diff = 0.11 >= 0.10 -> switch to b
  selected = am.getActiveAccount();
  assert.equal(selected.name, 'b');
  assert.equal(am.currentIndex, 1);
});

test('3. Both spill guards: target with unified5h = 0.95 or inside pausedUntil is not spilled onto', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, { routingStrategy: 'balanced', weeklyBalanceMargin: 0.10 });
  am.currentIndex = 0;
  am.accounts[0].quota.unified7d = 0.50;
  am.accounts[1].quota.unified7d = 0.10; // diff = 0.40 >= 0.10

  // Spill guard 1: unified5h = 0.95 >= 0.90
  am.accounts[1].quota.unified5h = 0.95;
  assert.equal(am.getActiveAccount().name, 'a', 'unified5h >= 0.90 blocks spill');

  // Clear 5h usage, but set pausedUntil
  am.accounts[1].quota.unified5h = 0.10;
  am.accounts[1].pausedUntil = Date.now() + 10_000;
  assert.equal(am.getActiveAccount().name, 'a', 'pausedUntil in future blocks spill');

  // Clear pausedUntil -> spill allowed
  am.accounts[1].pausedUntil = null;
  assert.equal(am.getActiveAccount().name, 'b');
});

test('4. Off-pointer detour: Fable-gated current account serves Opus, detour serves Fable, no pointer movement', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, { routingStrategy: 'balanced', weeklyBalanceMargin: 0.10 });
  am.currentIndex = 0;
  am.accounts[0].quota.unified7d = 0.20;
  am.accounts[0].quota.unified7dFable = 1.0; // Fable spent on a
  am.accounts[1].quota.unified7d = 0.20;
  am.accounts[1].quota.unified7dFable = 0.10;

  // Interleaved sequence:
  // 1. Fable request -> detours to b, currentIndex stays 0
  const fableAcc = am.getActiveAccount(null, FABLE);
  assert.equal(fableAcc.name, 'b');
  assert.equal(am.currentIndex, 0, 'detour did not move currentIndex');

  // 2. Opus request -> served by current (a)
  const opusAcc = am.getActiveAccount(null, OPUS);
  assert.equal(opusAcc.name, 'a');
  assert.equal(am.currentIndex, 0, 'Opus still served by current');
});

test('5. Advisor pass never mutates', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, { routingStrategy: 'balanced', weeklyBalanceMargin: 0.10 });
  am.currentIndex = 0;
  am.accounts[0].quota.unified7d = 0.20;
  am.accounts[0].quota.unified7dFable = 1.0; // a cannot serve Fable advisor
  am.accounts[1].quota.unified7d = 0.10;
  am.accounts[1].quota.unified7dFable = 0.10;

  // getActiveAccount with advisorModel = FABLE
  const acc = am.getActiveAccount(null, OPUS, FABLE);
  assert.equal(acc.name, 'b');
  assert.equal(am.currentIndex, 0, 'pass 1 was read-only, currentIndex untouched');
  assert.notEqual(am.accounts[1].rampStartedAt, null, 'rampStartedAt set on served off-pointer account');
});

test('Finding 1 regression: gated Fable request does not rank-move pointer away from priority winner', () => {
  const am = new AccountManager([oauth('a', { priority: 0 }), oauth('b', { priority: 1 })], 0.98, { routingStrategy: 'balanced', weeklyBalanceMargin: 0.10 });
  am.currentIndex = 0;
  am.accounts[0].quota.unified7d = 0.50;
  am.accounts[0].quota.unified7dFable = 1.0; // A is Fable-gated
  am.accounts[1].quota.unified7d = 0.30;
  am.accounts[1].quota.unified7dFable = 0.30;

  let pointerSwitches = 0;
  let lastPointer = am.currentIndex;

  for (let i = 0; i < 6; i++) {
    const model = (i % 2 === 0) ? FABLE : OPUS;
    am.getActiveAccount(null, model);
    if (am.currentIndex !== lastPointer) {
      pointerSwitches++;
      lastPointer = am.currentIndex;
    }
  }

  assert.ok(pointerSwitches <= 1, `expected at most 1 pointer switch, got ${pointerSwitches}`);
});

test('6. Forced all-null fleet: W is 0 empty, comparisons finite, selection returns account', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, { routingStrategy: 'balanced' });
  const Ws = am._computeAllW();
  assert.equal(Ws[0].value, 0);
  assert.equal(Ws[0].provenance, 'empty');
  assert.equal(Ws[1].value, 0);
  assert.equal(Ws[1].provenance, 'empty');
  assert.ok(Number.isFinite(Ws[0].value - Ws[1].value));

  const acc = am.getActiveAccount();
  assert.ok(acc != null);
});

test('7. Median fallback: one account null, others reported', () => {
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98, { routingStrategy: 'balanced' });
  am.accounts[0].quota.unified7d = 0.10;
  am.accounts[1].quota.unified7d = 0.50;
  // c is null

  const Ws = am._computeAllW();
  assert.equal(Ws[2].provenance, 'median');
  assert.ok(Math.abs(Ws[2].value - 0.30) < 1e-9);
});

test('8. W > 1.0: unified7dFable = 1.3 pushes through proxy-W, median, margin, gate without clamping', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, { routingStrategy: 'balanced', weeklyBalanceMargin: 0.10 });
  am.currentIndex = 0;
  am.accounts[0].quota.unified7dFable = 1.3;
  // W(a) is 1.3. b is null -> W(b) gets median = 1.3.

  const Ws = am._computeAllW();
  assert.equal(Ws[0].value, 1.3);
  assert.equal(Ws[0].provenance, 'family-proxy');
  assert.equal(Ws[1].value, 1.3);
  assert.equal(Ws[1].provenance, 'median');

  // a is available for Opus (since unified7dFable only gates Fable)
  const acc = am.getActiveAccount(null, OPUS);
  assert.ok(acc != null);
});

test('9. Detour-target change triggers _beginRamp; repeat detour to SAME target does not', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, { routingStrategy: 'balanced' });
  let rampCount = 0;
  am._beginRamp = () => { rampCount++; };
  am.currentIndex = 0;
  am.accounts[0].quota.unified7dFable = 1.0; // Fable detour to b

  // First detour to b
  am.getActiveAccount(null, FABLE);
  assert.equal(rampCount, 1);

  // Second detour to b for same bucket
  am.getActiveAccount(null, FABLE);
  assert.equal(rampCount, 1, 'repeat detour to same target does not re-trigger ramp');
});

test('10. _switchOnSessionReset is inert under balanced but still fires under drain', () => {
  const amBalanced = new AccountManager([oauth('a'), oauth('b')], 0.98, { routingStrategy: 'balanced' });
  amBalanced.currentIndex = 0;
  amBalanced.accounts[0].quota.unified7dReset = Date.now() + 100_000;
  amBalanced.accounts[1].quota.unified7dReset = Date.now() + 10_000;
  amBalanced._switchOnSessionReset([amBalanced.accounts[1]]);
  assert.equal(amBalanced.currentIndex, 0, 'inert under balanced');

  const amDrain = new AccountManager([oauth('a'), oauth('b')], 0.98, { routingStrategy: 'drain' });
  amDrain.currentIndex = 0;
  amDrain.accounts[0].quota.unified7dReset = Date.now() + 100_000;
  amDrain.accounts[1].quota.unified7dReset = Date.now() + 10_000;
  amDrain._switchOnSessionReset([amDrain.accounts[1]]);
  assert.equal(amDrain.currentIndex, 1, 'fires under drain');
});

test('11. Default config is drain and produces identical selections to pre-change behavior', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  assert.equal(am.routingStrategy, 'drain');
  am.accounts[0].quota.unified7d = 0.50;
  am.accounts[1].quota.unified7d = 0.10;
  assert.equal(am.getActiveAccount().name, 'a', 'drain picks first available account');
});

test('Invariant 5: detour ranks by GATE metric, not W', () => {
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98, { routingStrategy: 'balanced' });
  am.currentIndex = 0;
  // Current account A gated for Fable
  am.accounts[0].quota.unified7d = 0.20;
  am.accounts[0].quota.unified7dFable = 1.0;

  // Account B: unified7d = 0.10 (W = 0.10), unified7dFable = 0.50 (gate metric = 0.50)
  am.accounts[1].quota.unified7d = 0.10;
  am.accounts[1].quota.unified7dFable = 0.50;

  // Account C: unified7d = 0.30 (W = 0.30), unified7dFable = 0.20 (gate metric = 0.30)
  am.accounts[2].quota.unified7d = 0.30;
  am.accounts[2].quota.unified7dFable = 0.20;

  // A Fable detour must pick C because gate metric for C (0.30) < gate metric for B (0.50),
  // even though W(B) < W(C).
  const selected = am.getActiveAccount(null, FABLE);
  assert.equal(selected.name, 'c');
});

test('margin validation accepts 0 and defaults negatives/non-finite to 0.10', () => {
  const amZero = new AccountManager([oauth('a')], 0.98, { weeklyBalanceMargin: 0 });
  assert.equal(amZero.weeklyBalanceMargin, 0);

  const amNeg = new AccountManager([oauth('a')], 0.98, { weeklyBalanceMargin: -0.05 });
  assert.equal(amNeg.weeklyBalanceMargin, 0.10);

  const amInvalid = new AccountManager([oauth('a')], 0.98, { weeklyBalanceMargin: 'not-a-number' });
  assert.equal(amInvalid.weeklyBalanceMargin, 0.10);
});

test('removeAccount remaps _lastDetourTarget map indices', () => {
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98, { routingStrategy: 'balanced' });
  am.currentIndex = 0;
  am.accounts[0].quota.unified7dFable = 1.0; // Detour Fable
  am.getActiveAccount(null, FABLE); // Detour to b (index 1)
  assert.equal(am._lastDetourTarget.get('unified7dFable'), 1);

  // Remove account 0 (a). Account b becomes index 0, c becomes index 1.
  am.removeAccount(0);
  assert.equal(am._lastDetourTarget.get('unified7dFable'), 0);

  // Remove account 0 (now b). The detour target for b (index 0) is deleted.
  am.removeAccount(0);
  assert.equal(am._lastDetourTarget.get('unified7dFable'), undefined);
});

test('stuck-pointer regression: balancing happens under single-family traffic when globalBest is inadmissible', () => {
  const am = new AccountManager([oauth('x'), oauth('a'), oauth('b')], 0.98, { routingStrategy: 'balanced', weeklyBalanceMargin: 0.10 });
  am.accounts[0].quota.unified7d = 0.10;
  am.accounts[0].quota.unified7dFable = 1.0; // X is globalBest for W, but Fable-gated
  am.accounts[1].quota.unified7d = 0.60;     // A (current)
  am.accounts[2].quota.unified7d = 0.40;     // B (target, margin 0.20 below A)

  am.currentIndex = 1; // start on A

  const acc = am.getActiveAccount(null, FABLE);
  assert.equal(acc.name, 'b');
  assert.equal(am.currentIndex, 2, 'pointer moved from A to B under single-family traffic');
});

test('_lastDetourTarget is cleared on mutating switch', () => {
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98, { routingStrategy: 'balanced', weeklyBalanceMargin: 0.10 });
  am.currentIndex = 0;
  am.accounts[0].quota.unified7d = 0.20;
  am.accounts[0].quota.unified7dFable = 1.0; // Fable detour to b
  am.accounts[1].quota.unified7d = 0.20;
  am.accounts[2].quota.unified7d = 0.20;

  // Off-pointer Fable serve detours to b (index 1)
  am.getActiveAccount(null, FABLE);
  assert.equal(am._lastDetourTarget.get('unified7dFable'), 1);

  // Now a's W increases so a mutating switch to b occurs on next request
  am.accounts[0].quota.unified7d = 0.80; // W(a) = 0.80, W(b) = 0.20 -> margin move
  am.getActiveAccount(null, OPUS);
  assert.equal(am.currentIndex, 1, 'mutating switch moved pointer to b');
  assert.equal(am._lastDetourTarget.get('unified7dFable'), undefined, '_lastDetourTarget cleared on mutating switch');
});

