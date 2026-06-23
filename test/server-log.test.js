import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function makeStack(upstreamHandler) {
  const upstream = http.createServer(upstreamHandler);
  // Realistic-length token so the 20-char mask actually truncates it.
  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 'sk-ant-oat-SECRETvalue-0123456789', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }],
    0.98,
  );
  return { upstream, am };
}

test('reverse-proxy logs a non-streaming JSON response (pretty, masked)', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-revlog-'));
  const { upstream, am } = makeStack((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', usage: { input_tokens: 3, output_tokens: 5 } }));
  });
  const upPort = await listen(upstream);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upPort}`, logDir: dir });
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await res.text();
    await new Promise(r => setTimeout(r, 150)); // let the async file write land

    const file = readdirSync(dir).find(f => f.endsWith('.log'));
    assert.ok(file, 'a log file was written');
    const content = readFileSync(join(dir, file), 'utf8');
    assert.match(content, /=== REQUEST \(account: a/);
    assert.match(content, /\/v1\/messages/);
    assert.match(content, /=== REQUEST BODY ===/);
    assert.match(content, /=== RESPONSE 200 ===/);
    assert.match(content, /=== RESPONSE BODY ===/);
    assert.match(content, /"input_tokens": 3/);          // response pretty-printed
    assert.match(content, /authorization: Bearer sk-ant-oat-\S*\.\.\./); // injected token masked (first 20 chars)
    assert.ok(!content.includes('SECRETvalue-0123456789')); // full token tail never logged
  } finally {
    proxy.close(); upstream.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('a terminal 429 response is logged (head + status + body) for offline capture', { timeout: 20000 }, async () => {
  // A terminal 429 (one the proxy gives up on) must be persisted to the request
  // log — body + status + headers — so a real reactive usage-limit 429 wire-shape
  // can be captured for offline analysis (workstation Phase 7). Without this, the
  // only logging runs on the non-429 success path and the 429 body is read-and-
  // discarded by classifyLimitResponse, so a real limit event never hits disk.
  const dir = mkdtempSync(join(tmpdir(), 'tc-429log-'));
  // Distinctive marker in the body; classifies as 'unknown' (not the throttle
  // phrase, not the verbatim usage-limit message) → throttle/back-off path.
  const limitBody = JSON.stringify({
    type: 'error',
    error: { type: 'rate_limit_error', message: 'WIRE_SHAPE_MARKER reactive limit body' },
  });
  const upstream = http.createServer((_req, res) => {
    res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' });
    res.end(limitBody);
  });
  const upPort = await listen(upstream);
  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }],
    0.98,
  );
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upPort}`, logDir: dir });
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-8', messages: [] }),
    });
    await res.text();
    await new Promise(r => setTimeout(r, 200)); // let the async file write land

    const files = readdirSync(dir).filter(f => f.endsWith('.log'));
    assert.ok(files.length > 0, 'a log file was written for the terminal 429');
    const content = files.map(f => readFileSync(join(dir, f), 'utf8')).join('\n');
    assert.match(content, /=== REQUEST \(account: a/);   // request head captured
    assert.match(content, /=== RESPONSE 429 ===/);        // terminal 429 status logged
    assert.match(content, /=== RESPONSE BODY ===/);       // body section present
    assert.match(content, /WIRE_SHAPE_MARKER/);           // the 429 body itself captured
  } finally {
    proxy.close(); upstream.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('reverse-proxy streams an SSE response to the log as it arrives', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-revlog-sse-'));
  const { upstream, am } = makeStack(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n\n');
    await new Promise(r => setTimeout(r, 20));
    res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":11}}\n\n');
    res.end();
  });
  const upPort = await listen(upstream);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upPort}`, logDir: dir });
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true }),
    });
    await res.text();
    await new Promise(r => setTimeout(r, 150));

    const file = readdirSync(dir).find(f => f.endsWith('.log'));
    const content = readFileSync(join(dir, file), 'utf8');
    assert.match(content, /=== RESPONSE BODY \(streamed\) ===/);
    // SSE written verbatim (not JSON-reformatted): the raw "event:"/"data:"
    // lines survive intact, which a JSON pretty-printer would have mangled.
    assert.match(content, /event: message_start\ndata: \{"type":"message_start"/);
    assert.match(content, /event: message_delta/);
  } finally {
    proxy.close(); upstream.close(); rmSync(dir, { recursive: true, force: true });
  }
});
