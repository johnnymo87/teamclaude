import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

test('an Opus request routes to the account whose opus scope is healthy', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers['authorization']);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'tok-a', expiresAt: Date.now() + 3600_000 },
    { name: 'b', type: 'oauth', accessToken: 'tok-b', expiresAt: Date.now() + 3600_000 },
  ], 0.98, 0.90);
  for (const acc of am.accounts) { acc.quota.unified7dReset = Date.now() + 86_400_000; acc.probing = false; }
  am.currentIndex = 0;
  am.accounts[0].quota.scopedLimits = { opus: { utilization: 0.99, resetAt: Date.now() + 3600_000, severity: 'high', isActive: true } };

  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  try {
    await (await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-8', messages: [] }) })).text();
    assert.equal(seen.at(-1), 'Bearer tok-b');     // diverted to b

    await (await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }) })).text();
    assert.equal(seen.at(-1), 'Bearer tok-a');     // stays on primary
  } finally { proxy.close(); upstream.close(); }
});

test('a body without a model falls back to unified-only selection (no throw)', async () => {
  const upstream = http.createServer((_req, res) => { res.writeHead(200); res.end('{}'); });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 't', expiresAt: Date.now() + 3600_000 }], 0.98, 0.90);
  am.accounts[0].quota.unified7dReset = Date.now() + 86_400_000; am.accounts[0].probing = false;
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' });
    await res.text();
    assert.equal(res.status, 200);
  } finally { proxy.close(); upstream.close(); }
});

test('mid-stream SSE usage-limit error in a 200 response reactively marks the scope', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"type":"error","error":{"type":"rate_limit_error","message":"The usage limit has been reached"}}\n\n');
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'tok-a', expiresAt: Date.now() + 3600_000 }
  ], 0.98, 0.90);
  am.accounts[0].quota.unified7dReset = Date.now() + 86_400_000;
  am.accounts[0].probing = false;

  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);

  try {
    // POST an Opus request: the body uses the shared `rate_limit_error` type + the verbatim message (the design's primary shape)
    // [R2] MAJOR-1: prove the classifier is NOT gated on status===429 (this mid-stream arm classifies with status=200)
    await (await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-8', messages: [] })
    })).text();

    assert.equal(am.accounts[0].quota.scopedLimits?.opus?.utilization, 1);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('[R2] MAJOR-1: terminal 429 with a usage-limit body marks the opus scope and re-dispatches', async () => {
  let hits = 0;
  const upstream = http.createServer((_req, res) => {
    hits++;
    res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'The usage limit has been reached' } }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 'tok-a', expiresAt: Date.now() + 3600_000 }], 0.98, 0.90);
  am.accounts[0].quota.unified7dReset = Date.now() + 86_400_000; am.accounts[0].probing = false;
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-8', messages: [] }) });
    await res.text();
    assert.equal(am.accounts[0].quota.scopedLimits.opus.utilization, 1);   // scope marked on the terminal 429
  } finally { proxy.close(); upstream.close(); }
});
