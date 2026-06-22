/**
 * Map a model id (wire value `claude-opus-4-…`, opencode's provider-prefixed
 * `anthropic/claude-opus-4-8`, or a usage `scope.model.display_name` like
 * "Opus") to a coarse model class used for scoped-quota tracking. Returns null
 * for anything we don't gate on.
 */
export function modelClass(modelId) {
  if (typeof modelId !== 'string' || !modelId) return null;
  if (/opus/i.test(modelId)) return 'opus';
  if (/sonnet/i.test(modelId)) return 'sonnet';
  return null;
}
