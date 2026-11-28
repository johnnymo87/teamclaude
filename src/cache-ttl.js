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
// database. Results are cached briefly (a matching name for 10 minutes, anything else
// for 30 seconds, because goose may rename a session after its first request), so
// the database sees at most a couple of point queries a minute per session.
// Any database error means "no match": the lookup never breaks a request.
//
// ADAPTIVE RULE. With `"adaptive": {"enabled": true}` the id list and the
// names become only a PRIOR, and each session's own recent traffic decides.
// From every settled response we know the cached prompt size (cache read +
// cache write, the same under either TTL) and the time since the session's
// previous request for the same model (request START times, since the cache is
// touched at prefill, not when a long stream ends). That is enough to price the
// request under both TTLs whatever TTL it actually used (`scoreGap`, the same
// loss rule as the daily audit):
//   first request  1h pays 0.6 x the whole write
//   gap <= 5 min   both warm; 1h pays 0.6 x the newly cached tokens
//   5-60 min       only 1h is warm; it saves the shared prefix, minus that premium
//   > 60 min       both cold; 1h pays 0.6 x the whole rewrite
// (and a cache that shrank by more than half is a cold rewrite either way).
// The scores of the last `windowHours` are summed per session. Once a session
// has `minEvents` scored requests, 1h goes on when the sum reaches `onAbove`
// AND at least `minMidGaps` of them were 5-60 min gaps, and off when the sum
// falls to `offBelow`; in between it keeps its state, which starts from the
// prior. A session whose window empties forgets its state. A subagent without enough evidence of its own follows
// its parent's state. So a program that changes phase is followed within a
// window, without flapping on a single gap. Defaults: minEvents 6, minMidGaps
// 2, onAbove 100000, offBelow -50000, windowHours 24. State is in memory; after a restart
// it is rebuilt once from the tail of the usage ledger (`"replay": false` turns
// that off; then each session's first request after a restart is scored as a
// first write, even if its cache is still warm). Each decision is written to the ledger as `ttl` / `ttl_reason`.
//
// USAGE LEDGER. With TEAMCLAUDE_USAGE_LOG set, every settled Anthropic response
// appends one JSON line: time, account, weekly bucket, model, the request's
// session headers, the usage figures (cache writes split 5m / 1h), and the
// account's last-seen 7-day utilization. That is the raw material for fitting
// how weekly quota % moves with each token class.

import { statSync, readFileSync, appendFileSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';

const VALID_TTLS = new Set(['5m', '1h']);
const EMPTY = () => ({ ttl: null, sessions: new Set(), names: [], gooseSessionsDb: null, adaptive: null });
const ADAPTIVE_DEFAULTS = { minEvents: 6, minMidGaps: 2, onAbove: 100000, offBelow: -50000, windowHours: 24, replay: true };

function parseAdaptive(a) {
  if (!a || typeof a !== 'object' || a.enabled !== true) return null;
  const num = (k) => (Number.isFinite(a[k]) ? a[k] : ADAPTIVE_DEFAULTS[k]);
  const cfg = {
    minEvents: Math.max(1, Math.floor(num('minEvents'))),
    minMidGaps: Math.max(0, Math.floor(num('minMidGaps'))),
    onAbove: num('onAbove'),
    offBelow: num('offBelow'),
    windowMs: Math.max(1, num('windowHours')) * 3600_000,
    replay: a.replay !== false,
  };
  if (cfg.offBelow > cfg.onAbove) return null; // nonsense band: inert
  return cfg;
}
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
    rule = { ttl, sessions, names, gooseSessionsDb, adaptive: parseAdaptive(j?.adaptive) };
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

function gooseName(dbPath, id, nowMs, matches) {
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
  // A name that does not match yet may be a placeholder renamed later, so only
  // a MATCHING name is kept for long.
  nameCache.set(key, { name, until: nowMs + (name && matches(name) ? HIT_MS : MISS_MS) });
  return name;
}

function nameMatches(rule, id, nowMs) {
  if (!id || !GOOSE_ID.test(id)) return false;
  const matches = (name) => rule.names.some(re => re.test(name));
  const name = gooseName(rule.gooseSessionsDb, id, nowMs, matches);
  return !!name && matches(name);
}

// The static rule (id list, then names): 'list', 'name' or null.
function staticMatch(rule, session, parent, now) {
  if ((session && rule.sessions.has(session)) || (parent && rule.sessions.has(parent))) return 'list';
  if (!rule.names?.length || !rule.gooseSessionsDb) return null;
  const nowMs = now();
  if (nameMatches(rule, session, nowMs) || nameMatches(rule, parent, nowMs)) return 'name';
  return null;
}

// ---- adaptive state ----
const MAX_SESSIONS = 5000;
const MAX_EVENTS = 2000; // per session; a busy session's oldest events go first
let adaptive = new Map(); // session -> { models: Map<model,{ts,ctx}>, events: [{ts,net}], on: bool|null, lastTs }
let replayed = false;

export function _resetAdaptive() { adaptive = new Map(); replayed = false; }

// Sizes are cached-prompt tokens; `prevCtx` null means the session's first request.
export function scoreGap({ gapMs, prevCtx, ctx }) {
  if (prevCtx == null) return -0.6 * ctx;
  if (ctx < prevCtx / 2) return -0.6 * ctx; // compaction or a new prompt: cold either way
  const fresh = Math.max(0, ctx - prevCtx);
  if (gapMs <= 5 * 60_000) return fresh ? -0.6 * fresh : 0;
  if (gapMs <= 60 * 60_000) return Math.min(prevCtx, ctx) - 0.6 * fresh;
  return -0.6 * ctx;
}

const n0 = (x) => (Number.isFinite(x) ? x : 0);
const cachedSize = (u) => n0(u?.cache_read_input_tokens) + n0(u?.cache_creation_input_tokens);
const isMid = (gapMs) => gapMs > 5 * 60_000 && gapMs <= 60 * 60_000;

function prune(st, cutoff) {
  let i = 0;
  while (i < st.events.length && st.events[i].ts < cutoff) i++;
  if (i) st.events.splice(0, i);
}

function observe(cfg, session, model, usage, nowMs, scoreFirst = true) {
  if (!session) return;
  const ctx = cachedSize(usage);
  if (!ctx) return; // nothing was cached: says nothing about the cache
  let st = adaptive.get(session);
  if (!st) {
    if (adaptive.size >= MAX_SESSIONS) {
      const cutoff = nowMs - cfg.windowMs;
      for (const [k, v] of adaptive) if (v.lastTs < cutoff) adaptive.delete(k);
      if (adaptive.size >= MAX_SESSIONS) adaptive.delete(adaptive.keys().next().value);
    }
    st = { models: new Map(), events: [], on: null, lastTs: nowMs };
    adaptive.set(session, st);
  }
  const key = model || '';
  const prev = st.models.get(key);
  if ((prev && nowMs >= prev.ts) || (!prev && scoreFirst)) {
    const gapMs = prev ? nowMs - prev.ts : null;
    st.events.push({ ts: nowMs, mid: prev ? isMid(gapMs) : false, net: scoreGap({ gapMs, prevCtx: prev ? prev.ctx : null, ctx }) });
    if (st.events.length > MAX_EVENTS) st.events.splice(0, st.events.length - MAX_EVENTS);
  }
  if (!prev || nowMs >= prev.ts) st.models.set(key, { ts: nowMs, ctx });
  st.lastTs = Math.max(st.lastTs, nowMs);
}

// Feed one settled response into the adaptive state (no-op unless enabled).
export function observeUsage({ session, model, usage, now = Date.now() }, rule = loadTtlRule()) {
  if (!rule.adaptive) return;
  try { observe(rule.adaptive, session, model, usage, now); } catch { /* never break a response */ }
}

// The session's adaptive state after this decision: true/false, or null when it
// has too little evidence.
function decide(cfg, session, priorOn, nowMs) {
  const st = session && adaptive.get(session);
  if (!st) return null;
  prune(st, nowMs - cfg.windowMs);
  if (!st.events.length) st.on = null; // nothing left to go on
  if (st.on === null && st.events.length < cfg.minEvents) return null;
  if (st.events.length >= cfg.minEvents) {
    const sum = st.events.reduce((a, e) => a + e.net, 0);
    const mids = st.events.reduce((a, e) => a + (e.mid ? 1 : 0), 0);
    const was = st.on === null ? priorOn : st.on;
    const next = sum >= cfg.onAbove && mids >= cfg.minMidGaps ? true : sum <= cfg.offBelow ? false : was;
    if (st.on !== null && next !== st.on) console.log(`[cache-ttl] adaptive ${session} ${st.on ? 'on' : 'off'} -> ${next ? 'on' : 'off'} (window net ${Math.round(sum)} over ${st.events.length} requests)`);
    st.on = next;
  }
  return st.on;
}

// Rebuild the adaptive state from the last window of the usage ledger, once.
// Reads backwards in 1 MiB chunks only as far as the window reaches (a day is a
// few MiB), capped at `maxBytes`; returns the number of lines replayed. A
// session's first line in the window is not scored as a first request.
export function replayUsageLog(path, rule = loadTtlRule(), now = Date.now(), maxBytes = 64 * 1024 * 1024) {
  const cfg = rule.adaptive;
  if (!cfg || !path) return 0;
  const since = new Date(now - cfg.windowMs).toISOString();
  const until = new Date(now).toISOString();
  const CHUNK = 1024 * 1024;
  const chunks = [];
  let text = '';
  try {
    const fd = openSync(path, 'r');
    try {
      let pos = fstatSync(fd).size;
      const floor = Math.max(0, pos - maxBytes);
      while (pos > floor) {
        const len = Math.min(CHUNK, pos - floor);
        pos -= len;
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, pos);
        chunks.unshift(buf);
        // Stop once this chunk's first complete line is older than the window
        // (a line split across chunks only delays the stop by one chunk).
        const nl = buf.indexOf(10);
        if (pos > 0 && nl >= 0 && buf.toString('latin1', nl + 8, nl + 32) < since) break;
      }
      text = Buffer.concat(chunks).toString('utf8');
      if (pos > 0) text = text.slice(text.indexOf('\n') + 1);
    } finally { closeSync(fd); }
  } catch { return 0; }
  const rows = [];
  for (const line of text.split('\n')) {
    // `ts` is the first key; compare it as text before paying for a parse.
    const ts0 = line.slice(7, 31);
    if (ts0 < since || ts0 > until) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const t = Date.parse(r.req_ts ?? r.ts);
    if (!r.session || !Number.isFinite(t)) continue;
    // Rows written with no TTL decision (non-Anthropic bodies) were never observed live.
    if ('ttl_reason' in r && r.ttl_reason == null) continue;
    rows.push({ t, r });
  }
  rows.sort((a, b) => a.t - b.t);
  for (const { t, r } of rows) {
    observe(cfg, r.session, r.model, { cache_read_input_tokens: r.cache_read, cache_creation_input_tokens: r.cache_write }, t, false);
  }
  return rows.length;
}

// The TTL to apply to this request and why: { ttl, reason }. `reason` is
// 'list' / 'name' (static rule), 'adaptive-on' / 'adaptive-off' (the session's
// own evidence), 'adaptive-parent-on' / -off (its parent's), 'prior-list' /
// 'prior-name' / 'prior-none' (adaptive, but too little evidence yet), or null.
export function ttlDecision(headers, rule = loadTtlRule(), now = Date.now) {
  if (!rule.ttl) return { ttl: null, reason: null };
  const { session, parent } = sessionHeaders(headers);
  const cfg = rule.adaptive;
  if (!cfg) {
    const m = staticMatch(rule, session, parent, now);
    return { ttl: m ? rule.ttl : null, reason: m };
  }
  const nowMs = now();
  if (!replayed) {
    replayed = true;
    if (cfg.replay) { try { replayUsageLog(process.env.TEAMCLAUDE_USAGE_LOG, rule, nowMs); } catch { /* ignore */ } }
  }
  const m = staticMatch(rule, session, parent, now);
  const own = decide(cfg, session, !!m, nowMs);
  if (own !== null) return { ttl: own ? rule.ttl : null, reason: own ? 'adaptive-on' : 'adaptive-off' };
  const fromParent = parent ? decide(cfg, parent, !!staticMatch(rule, parent, null, now), nowMs) : null;
  if (fromParent !== null) return { ttl: fromParent ? rule.ttl : null, reason: fromParent ? 'adaptive-parent-on' : 'adaptive-parent-off' };
  return { ttl: m ? rule.ttl : null, reason: m ? `prior-${m}` : 'prior-none' };
}

// The TTL to apply to this request, or null.
export function ttlForRequest(headers, rule = loadTtlRule(), now = Date.now) {
  return ttlDecision(headers, rule, now).ttl;
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
    ttl: sessionKey?.ttl ?? null,
    ttl_reason: sessionKey?.ttlReason ?? null,
    req_ts: Number.isFinite(sessionKey?.reqStartMs) ? new Date(sessionKey.reqStartMs).toISOString() : null,
  });
}

export function appendUsageLog(fields, path = process.env.TEAMCLAUDE_USAGE_LOG) {
  if (!path) return;
  try { appendFileSync(path, usageLogLine(fields) + '\n'); } catch { /* never break a response */ }
}
