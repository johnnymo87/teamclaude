import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultConfig, validateRoutingConfig, VALID_ROUTING_STRATEGIES } from '../src/config.js';
import { AccountManager } from '../src/account-manager.js';

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

function closedPort() {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function oauth(name) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000 };
}

function runServer(configPath, { timeoutMs = 5000, extraArgs = [] } = {}) {
  const child = spawn(process.execPath, [cliPath, 'server', '--headless', ...extraArgs], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });

  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`server did not exit within ${timeoutMs}ms; stdout: ${stdout}; stderr: ${stderr}`));
    }, timeoutMs);

    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

// ── Default config ────────────────────────────────────────────────────────────

test('createDefaultConfig includes routingStrategy and weeklyBalanceMargin defaults', () => {
  const cfg = createDefaultConfig();
  assert.equal(cfg.routingStrategy, 'expiry');
  assert.equal(cfg.weeklyBalanceMargin, 0.10);
});

// ── validateRoutingConfig (pure validation) ───────────────────────────────────

test('validateRoutingConfig defaults routingStrategy to expiry when omitted', () => {
  assert.equal(validateRoutingConfig({}).routingStrategy, 'expiry');
  assert.equal(validateRoutingConfig(undefined).routingStrategy, 'expiry');
  assert.equal(validateRoutingConfig({ quotaProbeSeconds: 0 }).routingStrategy, 'expiry');
});

test('validateRoutingConfig accepts valid strategies: expiry, balanced, drain', () => {
  assert.deepEqual(VALID_ROUTING_STRATEGIES, ['expiry', 'balanced', 'drain']);
  assert.equal(validateRoutingConfig({ routingStrategy: 'expiry' }).routingStrategy, 'expiry');
  assert.equal(validateRoutingConfig({ routingStrategy: 'drain' }).routingStrategy, 'drain');
  assert.equal(validateRoutingConfig({ routingStrategy: 'balanced', quotaProbeSeconds: 90 }).routingStrategy, 'balanced');
});

test('validateRoutingConfig rejects unknown routingStrategy naming valid options', () => {
  for (const invalid of ['roundrobin', 'random', 'weighted', '', 123, null, false]) {
    assert.throws(
      () => validateRoutingConfig({ routingStrategy: invalid }),
      /Invalid.*routingStrategy.*Must be one of: expiry, balanced, drain|Valid strategies are: expiry, balanced, drain/
    );
  }
});

test('validateRoutingConfig rejects balanced strategy when quotaProbeSeconds is not > 0', () => {
  for (const invalidProbe of [0, -1, undefined, null, NaN]) {
    assert.throws(
      () => validateRoutingConfig({ routingStrategy: 'balanced', quotaProbeSeconds: invalidProbe }),
      /"balanced" routing strategy requires "quotaProbeSeconds" > 0/
    );
  }
});

// ── AccountManager constructor ────────────────────────────────────────────────

test('AccountManager defaults routingStrategy to expiry and margin to 0.10', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  assert.equal(am.routingStrategy, 'expiry');
  assert.equal(am.weeklyBalanceMargin, 0.10);
});

test('AccountManager accepts valid strategies and stores them', () => {
  for (const strategy of ['expiry', 'balanced', 'drain']) {
    const am = new AccountManager([oauth('a')], 0.98, { routingStrategy: strategy });
    assert.equal(am.routingStrategy, strategy);
  }
});

test('AccountManager loudly rejects unknown routingStrategy naming the valid values', () => {
  for (const invalid of ['roundrobin', 'bogus', 42, null]) {
    assert.throws(
      () => new AccountManager([oauth('a')], 0.98, { routingStrategy: invalid }),
      /Invalid routingStrategy.*Must be one of: expiry, balanced, drain/
    );
  }
});

test('AccountManager margin clamps: 0 -> 0.02, 0.01 -> 0.02, 0.03 stays 0.03, absent -> 0.10, non-finite -> 0.10', () => {
  const checkMargin = (val) => new AccountManager([oauth('a')], 0.98, { weeklyBalanceMargin: val }).weeklyBalanceMargin;

  assert.equal(checkMargin(0), 0.02);
  assert.equal(checkMargin(0.01), 0.02);
  assert.equal(checkMargin(-0.5), 0.02);
  assert.equal(checkMargin(0.03), 0.03);
  assert.equal(checkMargin(0.05), 0.05);
  assert.equal(checkMargin(0.15), 0.15);
  assert.equal(checkMargin(undefined), 0.10);
  assert.equal(checkMargin(NaN), 0.10);
  assert.equal(checkMargin(Infinity), 0.10);
  assert.equal(checkMargin(-Infinity), 0.10);
  assert.equal(checkMargin(null), 0.10);
  assert.equal(checkMargin('0.03'), 0.10);
});

test('AccountManager margin below 0.05 warns but is accepted (if >= 0.02)', () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  try {
    const am03 = new AccountManager([oauth('a')], 0.98, { weeklyBalanceMargin: 0.03 });
    assert.equal(am03.weeklyBalanceMargin, 0.03);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /weeklyBalanceMargin 0.03 is below 0.05/);

    warnings.length = 0;
    const am01 = new AccountManager([oauth('a')], 0.98, { weeklyBalanceMargin: 0.01 });
    assert.equal(am01.weeklyBalanceMargin, 0.02); // clamped
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /weeklyBalanceMargin 0.01 is below 0.05/);

    warnings.length = 0;
    const am0 = new AccountManager([oauth('a')], 0.98, { weeklyBalanceMargin: 0 });
    assert.equal(am0.weeklyBalanceMargin, 0.02); // clamped
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /weeklyBalanceMargin 0 is below 0.05/);

    // Margin >= 0.05 should NOT warn
    warnings.length = 0;
    const am05 = new AccountManager([oauth('a')], 0.98, { weeklyBalanceMargin: 0.05 });
    assert.equal(am05.weeklyBalanceMargin, 0.05);
    assert.equal(warnings.length, 0);

    // Absent or non-finite should NOT warn
    warnings.length = 0;
    new AccountManager([oauth('a')], 0.98, {});
    new AccountManager([oauth('a')], 0.98, { weeklyBalanceMargin: NaN });
    assert.equal(warnings.length, 0);
  } finally {
    console.warn = origWarn;
  }
});

// ── Startup fatal guards (CLI integration) ────────────────────────────────────

test('startup exits fatal when routingStrategy is balanced and quotaProbeSeconds is 0', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-test-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port: 0, apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    routingStrategy: 'balanced',
    quotaProbeSeconds: 0,
    accounts: [{ name: 'acct1', type: 'apikey', apiKey: 'sk-ant-test' }],
  }));

  const result = await runServer(configPath);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Fatal: "balanced" routing strategy requires "quotaProbeSeconds" > 0/);
});

test('startup exits fatal when routingStrategy is unknown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-test-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port: 0, apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    routingStrategy: 'invalid-strat',
    accounts: [{ name: 'acct1', type: 'apikey', apiKey: 'sk-ant-test' }],
  }));

  const result = await runServer(configPath);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Fatal: Invalid "routingStrategy": "invalid-strat"/);
  assert.match(result.stderr, /expiry, balanced, drain/);
});

test('startup succeeds with balanced when quotaProbeSeconds > 0 and logs resolved combination', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-test-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port: 0, apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    routingStrategy: 'balanced',
    quotaProbeSeconds: 90,
    expiryRouting: { enabled: true },
    accounts: [{ name: 'acct1', type: 'apikey', apiKey: 'sk-ant-test' }],
  }));

  const child = spawn(process.execPath, [cliPath, 'server', '--headless'], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', c => { output += c; });
  child.stderr.on('data', c => { output += c; });

  try {
    // Wait until listening
    for (let i = 0; i < 50; i++) {
      if (output.includes('Listening on port') || output.includes('TeamClaude Proxy')) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.match(output, /Listening on port|TeamClaude Proxy/);
    assert.match(output, /Routing: strategy=balanced, expiryRouting\.enabled=true/);
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => child.on('exit', r));
  }
});

test('config reload logs restart requirement on routingStrategy change and does not hot-swap', async () => {
  const port = await closedPort();
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-reload-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    routingStrategy: 'expiry',
    accounts: [{ name: 'acct1', type: 'apikey', apiKey: 'sk-ant-test' }],
  }));

  const child = spawn(process.execPath, [cliPath, 'server', '--headless'], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', c => { output += c; });
  child.stderr.on('data', c => { output += c; });

  try {
    for (let i = 0; i < 50; i++) {
      if (output.includes('TeamClaude Proxy') || output.includes('Listening on port')) break;
      await new Promise(r => setTimeout(r, 100));
    }

    // Update config on disk to balanced
    await writeFile(configPath, JSON.stringify({
      proxy: { port, apiKey: 'tc-test' },
      upstream: 'https://api.anthropic.com',
      routingStrategy: 'balanced',
      quotaProbeSeconds: 90,
      accounts: [{ name: 'acct1', type: 'apikey', apiKey: 'sk-ant-test' }],
    }));

    // Trigger reload
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/reload`, { method: 'POST' });
    assert.equal(res.status, 200);

    // Give stdout a moment to flush
    for (let i = 0; i < 20; i++) {
      if (output.includes('routingStrategy change requires a restart')) break;
      await new Promise(r => setTimeout(r, 50));
    }

    assert.match(output, /\[TeamClaude\] routingStrategy change requires a restart/);
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => child.on('exit', r));
  }
});
