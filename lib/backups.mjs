import fs from "node:fs";
import path from "node:path";
import { codexHome } from "./discovery.mjs";
import { parseJsonl, readRollout, sha256 } from "./rollout.mjs";
import { replaceFileVerified } from "./safe-replace.mjs";

function backupRoot() {
  return process.env.CONTEXT_STUDIO_BACKUP_DIR
    ? path.resolve(process.env.CONTEXT_STUDIO_BACKUP_DIR)
    : path.join(codexHome(), "context-studio", "backups");
}

function safeThreadId(threadId) {
  return String(threadId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function threadDir(threadId) {
  return path.join(backupRoot(), safeThreadId(threadId));
}

function readMetadata(metaPath) {
  try { return JSON.parse(fs.readFileSync(metaPath, "utf8")); }
  catch { return null; }
}

export function listBackups(threadId) {
  const dir = threadDir(threadId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".meta.json"))
    .map((entry) => readMetadata(path.join(dir, entry.name)))
    .filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function writeBackup({ sourcePath, buffer, reason, sourceHash, threadId, label = null, kind = "manual" }) {
  const dir = threadDir(threadId);
  fs.mkdirSync(dir, { recursive: true });
  const createdAt = new Date().toISOString();
  const id = `${createdAt.replace(/[:.]/g, "-")}-${kind}`;
  const dataPath = path.join(dir, `${id}.jsonl`);
  const metaPath = path.join(dir, `${id}.meta.json`);
  const metadata = {
    id, kind, label, reason, createdAt, threadId, sourcePath,
    sourceHash: sourceHash || sha256(buffer), size: buffer.length,
    dataPath,
  };
  fs.writeFileSync(dataPath, buffer, { flag: "wx" });
  fs.writeFileSync(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx" });
  return metadata;
}

export function ensureOriginalBackup(args) {
  const existing = listBackups(args.threadId).find((backup) => backup.kind === "original");
  if (existing) return { ...existing, created: false };
  return { ...writeBackup({ ...args, kind: "original", reason: "original-before-first-edit", label: "初始版本" }), created: true };
}

export function createManualBackup(args) {
  return writeBackup({ ...args, kind: "manual", reason: "manual", label: args.label || "手动备份" });
}

export function readBackup(threadId, backupId) {
  const backup = listBackups(threadId).find((item) => item.id === backupId);
  if (!backup) throw Object.assign(new Error("Backup version not found"), { code: "BACKUP_NOT_FOUND" });
  const resolved = path.resolve(backup.dataPath);
  const allowedDir = path.resolve(threadDir(threadId)) + path.sep;
  if (!resolved.startsWith(allowedDir)) throw Object.assign(new Error("Backup path escaped its thread directory"), { code: "INVALID_BACKUP" });
  const buffer = fs.readFileSync(resolved);
  if (backup.size !== buffer.length || backup.sourceHash !== sha256(buffer)) {
    throw Object.assign(new Error("Backup content does not match its recorded size or hash"), { code: "INVALID_BACKUP" });
  }
  const document = parseJsonl(buffer, resolved);
  if (!document.validation.ok || document.meta.threadId !== threadId) {
    throw Object.assign(new Error("Backup failed structural or thread identity validation"), { code: "INVALID_BACKUP", details: document.validation.issues });
  }
  return { backup, buffer, document };
}

export function removeBackupFiles(backup) {
  if (!backup) return;
  const metaPath = path.join(path.dirname(backup.dataPath), `${backup.id}.meta.json`);
  try { fs.unlinkSync(backup.dataPath); } catch {}
  try { fs.unlinkSync(metaPath); } catch {}
}

export function restoreBackup({ filePath, expectedHash, threadId, backupId }) {
  const current = readRollout(filePath);
  if (current.document.meta.threadId !== threadId) {
    throw Object.assign(new Error("The selected rollout does not belong to the requested thread"), { code: "THREAD_ID_MISMATCH" });
  }
  if (current.hash !== expectedHash) throw Object.assign(new Error("The rollout changed after it was opened. Reload before restoring."), { code: "RACE_DETECTED" });
  if (!current.document.status.idle) throw Object.assign(new Error(`Turn ${current.document.status.activeTurnId} is active.`), { code: "THREAD_ACTIVE" });
  const selected = readBackup(threadId, backupId);
  const tempPath = `${current.resolved}.context-studio.restore.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, selected.buffer, { flag: "wx" });
  try {
    const finalSnapshot = readRollout(current.resolved);
    if (!finalSnapshot.document.status.idle) throw Object.assign(new Error(`Turn ${finalSnapshot.document.status.activeTurnId} became active during restore.`), { code: "THREAD_BECAME_ACTIVE" });
    if (finalSnapshot.hash !== expectedHash) throw Object.assign(new Error("The rollout changed during restore."), { code: "RACE_DURING_SAVE" });
    replaceFileVerified({
      tempPath,
      targetPath: current.resolved,
      expectedTargetHash: expectedHash,
      replacementHash: sha256(selected.buffer),
    });
  } catch (error) {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    throw error;
  }
  return { restored: selected.backup, summary: readRollout(current.resolved).summary };
}
