function estimatePrefixTokens(text) {
  return Math.ceil(new TextEncoder().encode(String(text ?? "")).length / 4);
}

function longestCommonPrefix(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  let index = 0;
  const limit = Math.min(a.length, b.length);
  while (index < limit && a[index] === b[index]) index += 1;
  return a.slice(0, index);
}

export function analyzePrefixReuseState({ segments = [], entries = [], edits = new Map(), deletions = new Set(), activeTokens = 0 }) {
  const totalTokens = activeTokens || segments.reduce((sum, segment) => sum + segment.tokens, 0);
  const changed = (segment) => (segment.deleteId && deletions.has(segment.deleteId))
    || (segment.editId && edits.has(segment.editId));
  const firstIndex = segments.findIndex(changed);
  const dirty = edits.size > 0 || deletions.size > 0;

  if (firstIndex < 0) {
    return {
      kind: dirty ? "inactive" : "unchanged",
      badge: dirty ? "当前前缀未变" : "未修改",
      preservedTokens: totalTokens,
      ratio: totalTokens ? 100 : 0,
      detail: dirty ? "改动只位于 compact 前归档，不改变当前模型输入。" : "尚未修改当前模型可见历史。",
    };
  }

  const first = segments[firstIndex];
  let preservedTokens = segments.slice(0, firstIndex).reduce((sum, segment) => sum + segment.tokens, 0);
  if (first.editId && edits.has(first.editId) && !deletions.has(first.deleteId)) {
    const entry = entries.find((item) => item.id === first.editId);
    if (entry) preservedTokens += Math.min(first.tokens, estimatePrefixTokens(longestCommonPrefix(entry.text, edits.get(first.editId))));
  }
  preservedTokens = Math.min(totalTokens, Math.max(0, preservedTokens));
  const suffixOnly = !segments.slice(firstIndex + 1).some((segment) => !changed(segment));
  const ratio = totalTokens ? (preservedTokens / totalTokens) * 100 : 0;
  return {
    kind: suffixOnly ? "suffix" : "broken",
    badge: suffixOnly ? "仅修改尾部" : "中间前缀变化",
    preservedTokens,
    ratio,
    detail: suffixOnly
      ? `变化从“${first.label}”开始，之后没有保留的旧条目；前面的精确前缀仍有复用机会。`
      : `首个变化在“${first.label}”，其后的旧条目必须从这里重新计算。`,
  };
}

export function matchesEntryFilter(entry, filter) {
  if (filter === "archived") return Boolean(entry.archived);
  if (!entry.inActiveContext) return false;
  if (["active", "all"].includes(filter)) return true;
  if (filter === "editable") return Boolean(entry.editable);
  if (filter === "tool-output") return ["tool-output", "mcp-call"].includes(entry.kind);
  if (filter === "deletable") return Boolean(entry.deletable);
  if (filter === "locked") return !entry.editable && !entry.deletable;
  return filter === entry.kind;
}
