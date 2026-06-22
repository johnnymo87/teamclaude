// Conservative classifier for a possible upstream usage-limit response.
// Returns { kind: 'usage_limit'|'throttle'|'unknown', scope?: 'opus'|'sonnet'|null }.
// HARD RULE: only 'usage_limit' may mark a scope exhausted. Everything else
// (incl. the IP-keyed "temporarily limiting requests" throttle) → back off.
// TODO(workstation-yuz7): tighten error.type/scope extraction against the real
// captured limit response before relying on the proactive path being bypassed.
const THROTTLE_RE = /temporarily limiting requests|not your usage limit/i;

export function classifyLimitResponse(status, _headers = {}, bodyJson = null) {
  const err = bodyJson?.error || bodyJson;
  const type = err?.type;
  const msg = typeof err?.message === 'string' ? err.message : '';

  // The IP-keyed throttle must always be treated as back-off, never failover.
  if (THROTTLE_RE.test(msg)) return { kind: 'throttle' };

  // Structured per-account usage limit (primary predicate). 'rate_limit_error'
  // is ambiguous (it is ALSO the throttle's type), so we do NOT key on type for
  // it; instead match the verbatim usage-limit message. THROTTLE_RE already ran
  // first, so this stays IP-throttle-safe regardless of status.
  // [R2] MAJOR-1: do NOT gate the message clause on status===429 — the design's
  // PRIMARY shape is a mid-stream SSE error inside a 200, which the mid-stream
  // arm classifies with status=200. Gating on 429 made that path unreachable.
  const isUsageLimit =
    type === 'usage_limit_error' ||                 // forward-compatible bonus (unverified type)
    /usage limit has been reached/i.test(msg);      // observed §1.1 verbatim message
  if (isUsageLimit) {
    return { kind: 'usage_limit', scope: scopeFromBody(err) };
  }
  return { kind: 'unknown' };
}

// Best-effort scope extraction; null when absent → caller marks no specific
// scope (falls back to unified back-off). Refined in Phase 7.
function scopeFromBody(err) {
  const s = err?.scope?.model?.display_name || err?.model || '';
  if (/opus/i.test(s)) return 'opus';
  if (/sonnet/i.test(s)) return 'sonnet';
  return null;
}
