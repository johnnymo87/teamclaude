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
// NAME RULE. goose sends only its own session id (`YYYYMMDD_N`), which is new
// every day for a recurring job, so an id list goes stale. Two optional keys
// match goose sessions by NAME instead:
//   "names": ["live-window-*", "stallwatch-*"]   globs, `*` = anything,
//                                               anchored, case-insensitive
//   "gooseSessionsDb": "/home/dev/.local/share/goose/sessions/sessions.db"
// An id of goose's shape that is not listed is looked up read-only in that
// database. Results are cached briefly (a hit for 10 minutes, a miss for 30
// seconds, because goose may name a session only after its first request), so
// the database sees at most a couple of point queries a minute per session.
// Any database error means "no match": the lookup never breaks a request.
//
// USAGE LEDGER. With TEAMCLAUDE_USAGE_LOG set, every settled Anthropic response
// appends one JSON line: time, account, weekly bucket, model, the request's
// session headers, the usage figures (cache writes split 5m / 1h), and the
// account's last-seen 7-day utilization. That is the raw material for fitting
// how weekly quota % moves with each token class.

import { statSync, readFileSync, appendFileSync } from 'node:fs';

const VALID_TTLS = new Set(['5m', '1h']);
const EMPTY = () => ({ ttl: null, sessions: new Set(), names: [], gooseSessionsDb: null });
let cached = { path: null, mtimeMs: -1, rule: EMPTY() };

function globToRegex(glob) {
  const src = glob.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${src}$`, 'i');
}

export function loadTtlRule(path = process.env.TEAMCLAUDE_CACHE_TTL_FILE) {
  const empty = EMPTY();
  if (!path) return empty;
  let mtimeMs;
  try { mtimeMs = statSync(path).mtimeMs; } catch { return empty; }
  if (cached.path === path && cached.mtimeMs === mtimeMs) return cached.rule;
  let rule = empty;
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    const ttl = VALID_TTLS.has(j?.ttl) ? j.ttl : '1h';
    const sessions = new Set((Array.isArray(j?.sessions) ? j.sessions : []).filter(s => typeof s === 'string' && s));
    const names = (Array.isArray(j?.names) ? j.names : []).filter(g => typeof g === 'string' && g).map(globToRegex);
    const gooseSessionsDb = typeof j?.gooseSessionsDb === 'string' && j.gooseSessionsDb ? j.gooseSessionsDb : null;
    rule = { ttl, sessions, names, gooseSessionsDb };
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

const GOOSE_ID = /^\d{8}_\d+$/;
const HIT_MS = 10 * 60_000;
const MISS_MS = 30_000;
const MAX_CACHED = 2000;
let nameCache = new Map(); // `${db}\0${id}` -> { name, until }
let dbHandle = { path: null, db: null, openedAt: 0 };
const REOPEN_MS = 10 * 60_000; // re-open now and then, in case the file was replaced

export function _resetNameCache() {
  nameCache = new Map();
  try { dbHandle.db?.close(); } catch { /* ignore */ }
  dbHandle = { path: null, db: null, openedAt: 0 };
}

function gooseName(dbPath, id, nowMs) {
  const key = `${dbPath}\0${id}`;
  const hit = nameCache.get(key);
  if (hit && hit.until > nowMs) return hit.name;
  let name = null;
  try {
    if (dbHandle.path !== dbPath || !dbHandle.db || nowMs - dbHandle.openedAt > REOPEN_MS || nowMs < dbHandle.openedAt) {
      try { dbHandle.db?.close(); } catch { /* ignore */ }
      dbHandle = { path: null, db: null, openedAt: 0 };
      const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
      dbHandle = { path: dbPath, db: new DatabaseSync(dbPath, { readOnly: true }), openedAt: nowMs };
    }
    const row = dbHandle.db.prepare('select name from sessions where id = ?').get(id);
    name = typeof row?.name === 'string' ? row.name : null;
  } catch {
    try { dbHandle.db?.close(); } catch { /* ignore */ }
    dbHandle = { path: null, db: null, openedAt: 0 };
  }
  if (nameCache.size >= MAX_CACHED) nameCache.clear();
  nameCache.set(key, { name, until: nowMs + (name ? HIT_MS : MISS_MS) });
  return name;
}

function nameMatches(rule, id, nowMs) {
  if (!id || !GOOSE_ID.test(id)) return false;
  const name = gooseName(rule.gooseSessionsDb, id, nowMs);
  return !!name && rule.names.some(re => re.test(name));
}

// The TTL to apply to this request, or null.
export function ttlForRequest(headers, rule = loadTtlRule(), now = Date.now) {
  if (!rule.ttl) return null;
  const { session, parent } = sessionHeaders(headers);
  if ((session && rule.sessions.has(session)) || (parent && rule.sessions.has(parent))) return rule.ttl;
  if (!rule.names?.length || !rule.gooseSessionsDb) return null;
  const nowMs = now();
  if (nameMatches(rule, session, nowMs) || nameMatches(rule, parent, nowMs)) return rule.ttl;
  return null;
}

// Set `ttl` on every `cache_control` of type ephemeral that has none, at the
// documented positions only (top level, system[], tools[], messages[].content[]
// and the nested content of a tool_result) -- never inside tool_use.input or
// metadata, which are the model's/client's own data. Returns the same Buffer
// when nothing changed (or the body is not JSON), so callers detect a rewrite
// by identity. Skips the whole body if the client already set an explicit
// "5m" anywhere: Anthropic requires 1h entries to precede 5m ones, and
// upgrading a later unset breakpoint past an explicit 5m one would 400.
export function applyCacheTtl(body, ttl) {
  if (!ttl || !body || body.length === 0) return body;
  let json;
  try { json = JSON.parse(body.toString('utf8')); } catch { return body; }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return body;
  const targets = [];
  const take = (node) => {
    const cc = node && typeof node === 'object' ? node.cache_control : undefined;
    if (cc && typeof cc === 'object' && !Array.isArray(cc) && cc.type === 'ephemeral') targets.push(cc);
  };
  take(json);
  for (const k of ['system', 'tools']) if (Array.isArray(json[k])) json[k].forEach(take);
  if (Array.isArray(json.messages)) {
    for (const m of json.messages) {
      if (!m || !Array.isArray(m.content)) continue;
      for (const block of m.content) {
        take(block);
        if (block && block.type === 'tool_result' && Array.isArray(block.content)) block.content.forEach(take);
      }
    }
  }
  if (targets.some(cc => cc.ttl === '5m')) return body;
  let changed = 0;
  for (const cc of targets) if (cc.ttl === undefined) { cc.ttl = ttl; changed++; }
  return changed ? Buffer.from(JSON.stringify(json), 'utf8') : body;
}

// `sessionKey` may carry `util7d`/`util5h` snapshotted from THIS response's
// rate-limit headers; when absent, `util7d` (the account's last-seen value,
// possibly moved by a concurrent response) is logged with source "cached".
export function usageLogLine({ account, bucket, model, sessionKey, usage, util7d, bucketUtil, now = Date.now() }) {
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
    util7d: Number.isFinite(sessionKey?.util7d) ? sessionKey.util7d : (Number.isFinite(util7d) ? util7d : null),
    util7d_source: Number.isFinite(sessionKey?.util7d) ? 'response' : (Number.isFinite(util7d) ? 'cached' : null),
    util5h: Number.isFinite(sessionKey?.util5h) ? sessionKey.util5h : null,
    bucket_util: Number.isFinite(bucketUtil) ? bucketUtil : null,
  });
}

export function appendUsageLog(fields, path = process.env.TEAMCLAUDE_USAGE_LOG) {
  if (!path) return;
  try { appendFileSync(path, usageLogLine(fields) + '\n'); } catch { /* never break a response */ }
}
