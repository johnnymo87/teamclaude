// Per-session prompt-cache TTL override and a per-response usage ledger.
//
// CACHE TTL. Anthropic's default `cache_control: {type: "ephemeral"}` lives 5
// minutes; a client idle longer re-caches its whole context on the next call.
// `ttl: "1h"` keeps it an hour (writes bill 2x base input instead of 1.25x).
// Clients like opencode hardcode the 5-minute form, so this proxy can upgrade
// it for an opt-in list of sessions, matched on the headers opencode sends
// (`x-session-affinity` / `X-Session-Id` = the session, `x-parent-session-id` =
// its parent, so a listed session's direct subagents match too).
//
// The list is a JSON file named by TEAMCLAUDE_CACHE_TTL_FILE:
//   {"ttl": "1h", "sessions": ["ses_...", ...]}
// It is re-read whenever its mtime changes (no restart), and a missing or
// malformed file means "no sessions" -- the feature is inert unless configured.
//
// USAGE LEDGER. With TEAMCLAUDE_USAGE_LOG set, every settled Anthropic response
// appends one JSON line: time, account, weekly bucket, model, the request's
// session headers, the usage figures (cache writes split 5m / 1h), and the
// account's last-seen 7-day utilization. That is the raw material for fitting
// how weekly quota % moves with each token class.

import { statSync, readFileSync, appendFileSync } from 'node:fs';

const VALID_TTLS = new Set(['5m', '1h']);
let cached = { path: null, mtimeMs: -1, rule: { ttl: null, sessions: new Set() } };

export function loadTtlRule(path = process.env.TEAMCLAUDE_CACHE_TTL_FILE) {
  const empty = { ttl: null, sessions: new Set() };
  if (!path) return empty;
  let mtimeMs;
  try { mtimeMs = statSync(path).mtimeMs; } catch { return empty; }
  if (cached.path === path && cached.mtimeMs === mtimeMs) return cached.rule;
  let rule = empty;
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    const ttl = VALID_TTLS.has(j?.ttl) ? j.ttl : '1h';
    const sessions = new Set((Array.isArray(j?.sessions) ? j.sessions : []).filter(s => typeof s === 'string' && s));
    rule = { ttl, sessions };
  } catch { /* malformed: inert */ }
  cached = { path, mtimeMs, rule };
  return rule;
}

function header(headers, name) {
  const v = headers?.[name];
  return typeof v === 'string' && v ? v : null;
}

export function sessionHeaders(headers) {
  return {
    session: header(headers, 'x-session-affinity') ?? header(headers, 'x-session-id'),
    parent: header(headers, 'x-parent-session-id'),
  };
}

// The TTL to apply to this request, or null.
export function ttlForRequest(headers, rule = loadTtlRule()) {
  if (!rule.ttl || rule.sessions.size === 0) return null;
  const { session, parent } = sessionHeaders(headers);
  if ((session && rule.sessions.has(session)) || (parent && rule.sessions.has(parent))) return rule.ttl;
  return null;
}

// Set `ttl` on every `cache_control` of type ephemeral that has none. Returns
// the same Buffer when nothing changed (or the body is not JSON), so callers
// can detect a rewrite by identity. An explicit ttl the client chose is kept.
export function applyCacheTtl(body, ttl) {
  if (!ttl || !body || body.length === 0) return body;
  let json;
  try { json = JSON.parse(body.toString('utf8')); } catch { return body; }
  let changed = 0;
  const walk = (node) => {
    if (Array.isArray(node)) { for (const x of node) walk(x); return; }
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'cache_control' && v && typeof v === 'object' && !Array.isArray(v)) {
        if (v.type === 'ephemeral' && v.ttl === undefined) { v.ttl = ttl; changed++; }
      } else walk(v);
    }
  };
  walk(json);
  return changed ? Buffer.from(JSON.stringify(json), 'utf8') : body;
}

export function usageLogLine({ account, bucket, model, sessionKey, usage, util7d, now = Date.now() }) {
  const n = (x) => (Number.isFinite(x) ? x : 0);
  const cc = usage?.cache_creation || {};
  return JSON.stringify({
    ts: new Date(now).toISOString(),
    account: account ?? null,
    bucket: bucket ?? null,
    model: model ?? null,
    session: sessionKey?.session ?? null,
    parent: sessionKey?.parent ?? null,
    input: n(usage?.input_tokens),
    cache_read: n(usage?.cache_read_input_tokens),
    cache_write: n(usage?.cache_creation_input_tokens),
    cache_write_5m: n(cc.ephemeral_5m_input_tokens),
    cache_write_1h: n(cc.ephemeral_1h_input_tokens),
    output: n(usage?.output_tokens),
    util7d: Number.isFinite(util7d) ? util7d : null,
  });
}

export function appendUsageLog(fields, path = process.env.TEAMCLAUDE_USAGE_LOG) {
  if (!path) return;
  try { appendFileSync(path, usageLogLine(fields) + '\n'); } catch { /* never break a response */ }
}
