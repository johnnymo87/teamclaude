import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { refreshAccessToken, __resetRefreshFieldReporting } from '../src/oauth.js';

/**
 * The refresh response is destructured down to three fields and the rest is
 * dropped. If the endpoint ever reports anything about the GRANT's lifetime --
 * as opposed to the access token's -- we would never see it. These tests pin
 * the behaviour that we at least log the field NAMES, once per distinct shape,
 * and never the values.
 */
async function withServer(body, fn) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/token`;
  try {
    return await fn(url);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('logs the field names of a refresh response, once per distinct shape', async () => {
  __resetRefreshFieldReporting();
  const logs = [];
  const spy = mock.method(console, 'log', msg => logs.push(String(msg)));
  try {
    await withServer(
      { access_token: 'sk-at', refresh_token: 'sk-rt', expires_in: 3600, refresh_token_expires_at: 12345 },
      async url => {
        await refreshAccessToken('sk-old', url);
        await refreshAccessToken('sk-old', url);
      },
    );
  } finally {
    spy.mock.restore();
  }
  const lines = logs.filter(l => l.includes('refresh response fields'));
  assert.equal(lines.length, 1, 'identical shapes must not re-log every hour');
  assert.match(lines[0], /access_token/);
  assert.match(lines[0], /refresh_token_expires_at/);
});

test('never logs a credential value', async () => {
  __resetRefreshFieldReporting();
  const logs = [];
  const spy = mock.method(console, 'log', msg => logs.push(String(msg)));
  try {
    await withServer(
      { access_token: 'sk-secret-access', refresh_token: 'sk-secret-refresh', expires_in: 3600 },
      async url => { await refreshAccessToken('sk-old', url); },
    );
  } finally {
    spy.mock.restore();
  }
  const blob = logs.join('\n');
  assert.ok(!blob.includes('sk-secret-access'), 'access token leaked into the log');
  assert.ok(!blob.includes('sk-secret-refresh'), 'refresh token leaked into the log');
});

test('a NEW field shape is reported even after an earlier one was seen', async () => {
  __resetRefreshFieldReporting();
  const logs = [];
  const spy = mock.method(console, 'log', msg => logs.push(String(msg)));
  try {
    await withServer({ access_token: 'a', refresh_token: 'b', expires_in: 1 },
      async url => { await refreshAccessToken('sk-old', url); });
    await withServer({ access_token: 'a', refresh_token: 'b', expires_in: 1, grant_expires_at: 9 },
      async url => { await refreshAccessToken('sk-old', url); });
  } finally {
    spy.mock.restore();
  }
  const lines = logs.filter(l => l.includes('refresh response fields'));
  assert.equal(lines.length, 2);
  assert.match(lines[1], /grant_expires_at/);
});
