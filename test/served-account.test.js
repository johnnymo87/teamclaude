// Which account served a request, told to the caller, and a pin that holds.
//
// A caller that wants to send a later request to the account that served an
// earlier one (cfp's keep-warm poke, which only refreshes a prompt cache on the
// account that holds it) needs two things from the proxy: the serving account's
// identity on the response, in a form it can pin with, and a pin that never
// lands the request anywhere else. The identity is the config entry's opaque
// `id` (account-id.js), never the name, which is usually an email address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, resolveAccountPin, SERVED_ACCOUNT_HEADER } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function oauth(name, id) {
  return { id, name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000 };
}

const ALPHA_ID = '11111111-1111-4111-8111-111111111111';
const BETA_ID = '22222222-2222-4222-8222-222222222222';

async function withProxy(respond, run) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ path: req.url, auth: req.headers.authorization });
    respond(req, res, seen.length);
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    oauth('alpha@example.com (Acme)', ALPHA_ID),
    oauth('beta@example.com (Acme)', BETA_ID),
  ], 0.98);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);
  try {
    return await run({ proxyPort, seen, am });
  } finally {
    proxy.close();
    upstream.close();
  }
}

const ok = (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
};

const post = (url) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
  body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] }),
});

test('the header name is the one cfp reads', () => {
  assert.equal(SERVED_ACCOUNT_HEADER, 'x-teamclaude-account-id');
});

test('resolveAccountPin accepts an entry id, ahead of every other form', () => {
  const am = new AccountManager([
    oauth('alpha', ALPHA_ID),
    // An account NAMED after another's id still loses to the id itself.
    oauth(ALPHA_ID, BETA_ID),
  ], 0.98);
  assert.equal(resolveAccountPin(am, ALPHA_ID), 0);
  assert.equal(resolveAccountPin(am, BETA_ID), 1);
  assert.equal(resolveAccountPin(am, ALPHA_ID.toUpperCase()), 0);
});

test('a served response names the serving account by entry id, not by name', async () => {
  await withProxy(ok, async ({ proxyPort, seen }) => {
    const res = await post(`http://127.0.0.1:${proxyPort}/v1/messages`);
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(seen[0].auth, 'Bearer t-alpha@example.com (Acme)');
    assert.equal(res.headers.get(SERVED_ACCOUNT_HEADER), ALPHA_ID);
    for (const [k, v] of res.headers) assert.ok(!v.includes('@'), `header ${k} carries an address: ${v}`);
  });
});

test('the reported id pins the next request to the same account', async () => {
  await withProxy(ok, async ({ proxyPort, seen, am }) => {
    am.currentIndex = 1;
    const first = await post(`http://127.0.0.1:${proxyPort}/v1/messages`);
    await first.text();
    const id = first.headers.get(SERVED_ACCOUNT_HEADER);
    assert.equal(id, BETA_ID);
    am.currentIndex = 0; // rotation has moved on
    const second = await post(`http://127.0.0.1:${proxyPort}/tc-acct/${encodeURIComponent(id)}/v1/messages`);
    await second.text();
    assert.equal(second.status, 200);
    assert.equal(seen[1].auth, seen[0].auth);
    assert.equal(seen[1].path, '/v1/messages');
    assert.equal(second.headers.get(SERVED_ACCOUNT_HEADER), BETA_ID);
  });
});

test('an account without an id gets no header rather than a guess', async () => {
  const upstream = http.createServer(ok);
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([oauth('alpha', undefined)], 0.98);
  am.accounts[0].id = null;
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  try {
    const res = await post(`http://127.0.0.1:${proxyPort}/v1/messages`);
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get(SERVED_ACCOUNT_HEADER), null);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('/teamclaude/status lists each account\'s entry id', async () => {
  await withProxy(ok, async ({ proxyPort }) => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/teamclaude/status`, { headers: { 'x-api-key': 'k' } });
    const body = await res.json();
    assert.deepEqual(body.accounts.map(a => a.id), [ALPHA_ID, BETA_ID]);
  });
});

// A pinned request must never fail over: the two one-hop detours (an
// account-scoped 429 without a quota rejection, and a 5xx) used to move it to
// another account, which for a keep-warm poke writes a cache on an account the
// conversation is not on.
test('a pinned request that meets a plain 429 is not hopped to another account', async () => {
  const respond = (_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1', 'anthropic-ratelimit-unified-status': 'allowed' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }));
  };
  await withProxy(respond, async ({ proxyPort, seen }) => {
    const res = await post(`http://127.0.0.1:${proxyPort}/tc-acct/${BETA_ID}/v1/messages`);
    await res.text();
    assert.notEqual(res.status, 200);
    assert.ok(seen.length >= 1);
    for (const s of seen) assert.equal(s.auth, 'Bearer t-beta@example.com (Acme)', 'the pin leaked to another account');
  });
});

test('a pinned request that meets a 5xx is not hopped to another account', async () => {
  const respond = (_req, res) => {
    res.writeHead(529, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }));
  };
  await withProxy(respond, async ({ proxyPort, seen }) => {
    const res = await post(`http://127.0.0.1:${proxyPort}/tc-acct/${BETA_ID}/v1/messages`);
    await res.text();
    assert.notEqual(res.status, 200);
    assert.ok(seen.length >= 1);
    for (const s of seen) assert.equal(s.auth, 'Bearer t-beta@example.com (Acme)', 'the pin leaked to another account');
  });
});

test('an unpinned request still takes the one-hop 5xx detour', async () => {
  const respond = (_req, res, n) => {
    if (n === 1) {
      res.writeHead(529, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }));
      return;
    }
    ok(_req, res);
  };
  await withProxy(respond, async ({ proxyPort, seen }) => {
    const res = await post(`http://127.0.0.1:${proxyPort}/v1/messages`);
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(seen.length, 2);
    assert.notEqual(seen[1].auth, seen[0].auth);
    // The header names the account that finally served it.
    assert.equal(res.headers.get(SERVED_ACCOUNT_HEADER), seen[1].auth.includes('beta') ? BETA_ID : ALPHA_ID);
  });
});

// Where would a request for this model land right now? A keep-warm poke is
// worth sending only to the account the conversation's next request will use:
// refreshing a cache there is a read, refreshing it anywhere else is waste.
// Requests with no session id (cfp's) have no affinity, so the answer is the
// fleet's preview for the model, the same one the TUI draws.
const target = async (port, model) => {
  const q = model == null ? '' : `?model=${encodeURIComponent(model)}`;
  const res = await fetch(`http://127.0.0.1:${port}/teamclaude/route-target${q}`, { headers: { 'x-api-key': 'k' } });
  return { status: res.status, body: await res.json() };
};

test('/teamclaude/route-target names the account a request for the model would land on', async () => {
  await withProxy(ok, async ({ proxyPort, am }) => {
    am.currentIndex = 1;
    assert.deepEqual(await target(proxyPort, 'claude-sonnet-4-5'), { status: 200, body: { model: 'claude-sonnet-4-5', id: BETA_ID } });
    am.currentIndex = 0;
    assert.equal((await target(proxyPort, 'claude-sonnet-4-5')).body.id, ALPHA_ID);
    // An account out of rotation is never the target.
    am.accounts[0].disabled = true;
    assert.equal((await target(proxyPort, 'claude-sonnet-4-5')).body.id, BETA_ID);
    am.accounts[1].disabled = true;
    assert.equal((await target(proxyPort, 'claude-sonnet-4-5')).body.id, null);
  });
});

test('/teamclaude/route-target agrees with where the request then goes', async () => {
  await withProxy(ok, async ({ proxyPort, am, seen }) => {
    am.currentIndex = 1;
    const { body } = await target(proxyPort, 'claude-sonnet-4-5');
    const res = await post(`http://127.0.0.1:${proxyPort}/v1/messages`);
    await res.text();
    assert.equal(res.headers.get(SERVED_ACCOUNT_HEADER), body.id);
    assert.equal(seen.length, 1);
  });
});

test('/teamclaude/route-target without a model is a 400', async () => {
  await withProxy(ok, async ({ proxyPort }) => {
    const { status, body } = await target(proxyPort, null);
    assert.equal(status, 400);
    assert.equal(body.error.type, 'invalid_request_error');
  });
});

// A pin is resolved to an array position once, and removing an account
// renumbers the array. A retry inside the same request (here: the forced token
// refresh after a 401) must follow the pinned account, not the position.
test('a pinned request whose account is renumbered mid-request stays on that account', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    if (seen.length === 1) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'expired' } }));
      return;
    }
    ok(req, res);
  });
  const upstreamPort = await listen(upstream);
  let am;
  const refreshFn = async () => {
    am.removeAccount(0); // beta moves from index 1 to 0, gamma from 2 to 1
    return { accessToken: 't-beta-2', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 };
  };
  am = new AccountManager([
    oauth('alpha', ALPHA_ID), oauth('beta', BETA_ID), oauth('gamma', '33333333-3333-4333-8333-333333333333'),
  ], 0.98, { refreshFn, forcedRefreshFloorMs: 0 });
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  try {
    const res = await post(`http://127.0.0.1:${proxyPort}/tc-acct/${BETA_ID}/v1/messages`);
    await res.text();
    assert.equal(seen[0], 'Bearer t-beta');
    for (const a of seen.slice(1)) assert.ok(!a.includes('gamma'), `the pin moved to gamma: ${seen.join(', ')}`);
    if (res.status === 200) assert.equal(res.headers.get(SERVED_ACCOUNT_HEADER), BETA_ID);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('an id two accounts share resolves to neither', () => {
  const am = new AccountManager([oauth('alpha', ALPHA_ID), oauth('beta', BETA_ID)], 0.98);
  am.accounts[1].id = ALPHA_ID;
  assert.equal(resolveAccountPin(am, ALPHA_ID), null);
});

// The pin is resolved from the URL before the body is read. An account removed
// while the body is still arriving must not move it either.
test('a pin resolved before the body arrives survives renumbering during body intake', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => { seen.push(req.headers.authorization); ok(req, res); });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    oauth('alpha', ALPHA_ID), oauth('beta', BETA_ID), oauth('gamma', '33333333-3333-4333-8333-333333333333'),
  ], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  try {
    const body = JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] });
    const status = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: proxyPort, method: 'POST', path: `/tc-acct/${BETA_ID}/v1/messages`,
        headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'content-length': Buffer.byteLength(body) },
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.write(body.slice(0, 10));
      setTimeout(() => { am.removeAccount(0); req.end(body.slice(10)); }, 100);
    });
    assert.equal(status, 200);
    assert.deepEqual(seen, ['Bearer t-beta']);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('/teamclaude/route-target declines to predict while sessions are distributed', async () => {
  await withProxy(ok, async ({ proxyPort, am }) => {
    am.distributeSessions = true;
    const { status, body } = await target(proxyPort, 'claude-sonnet-4-5');
    assert.equal(status, 200);
    assert.equal('id' in body, false);
    assert.equal(typeof body.unpredictable, 'string');
  });
});
