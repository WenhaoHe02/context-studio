export function prepareSubagentFork() {
  throw Object.assign(
    new Error("Fork is temporarily disabled while its task and subagent semantics are being redesigned."),
    { code: "FORK_FEATURE_DISABLED" },
  );
}
