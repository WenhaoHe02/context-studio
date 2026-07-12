const INLINE_TEXT_LIMIT = 12_000;
const PREVIEW_TEXT_LIMIT = 2_000;

export function compactUiSummary(summary) {
  return {
    ...summary,
    entries: summary.entries.map((entry) => {
      if (entry.editable || String(entry.text || "").length <= INLINE_TEXT_LIMIT) return entry;
      const text = String(entry.text || "");
      return { ...entry, text: text.slice(0, PREVIEW_TEXT_LIMIT), textLength: text.length, textOmitted: true };
    }),
  };
}

export function findUiEntry(summary, entryId) {
  const entry = summary.entries.find((item) => item.id === entryId);
  if (!entry) throw Object.assign(new Error("The context entry no longer exists."), { code: "ENTRY_NOT_FOUND" });
  return { id: entry.id, text: entry.text };
}
