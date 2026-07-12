import fs from "node:fs";

const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);

function pause(milliseconds) {
  if (milliseconds <= 0) return;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

/**
 * Replace a validated rollout temp file.
 *
 * This deliberately fails closed when the target is locked. Overwriting an
 * open rollout can diverge from Codex's in-memory history and can leave a
 * truncated file if the process is interrupted between truncate and flush.
 */
export function replaceFileVerified({
  tempPath,
  targetPath,
  retryDelays = [25, 50, 100, 200, 400],
}) {
  let renameError = null;
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      fs.renameSync(tempPath, targetPath);
      return { mode: "atomic-rename", recoveryPath: null };
    } catch (error) {
      renameError = error;
      if (!RETRYABLE.has(error.code) || attempt === retryDelays.length) break;
      pause(retryDelays[attempt]);
    }
  }
  if (!renameError || !RETRYABLE.has(renameError.code)) throw renameError;
  const wrapped = new Error("Codex still has this rollout open. Archive the task to unload it, then retry the staged commit.");
  wrapped.code = "FILE_BUSY";
  wrapped.cause = renameError;
  throw wrapped;
}
