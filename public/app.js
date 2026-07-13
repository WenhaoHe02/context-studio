const state = {
  rollouts: [],
  current: null,
  edits: new Map(),
  deletions: new Set(),
  backups: [],
  expandedParents: new Set(),
  expanded: new Set(),
  page: 1,
  pageSize: 40,
  filter: "all",
  query: "",
  syncing: false,
};

const $ = (selector) => document.querySelector(selector);
const els = {
  rolloutList: $("#rolloutList"), searchInput: $("#searchInput"), refreshButton: $("#refreshButton"),
  emptyEditor: $("#emptyEditor"), editorContent: $("#editorContent"), fileTitle: $("#fileTitle"),
  filePath: $("#filePath"), idleBadge: $("#idleBadge"), threadId: $("#threadId"),
  validationBadge: $("#validationBadge"), entryList: $("#entryList"), entrySearch: $("#entrySearch"),
  reloadButton: $("#reloadButton"), saveButton: $("#saveButton"), dirtyBadge: $("#dirtyBadge"),
  browserButton: $("#browserButton"), fullscreenButton: $("#fullscreenButton"), themeToggle: $("#themeToggle"), backupButton: $("#backupButton"), backupVersions: $("#backupVersions"), restoreButton: $("#restoreButton"),
  historyTokens: $("#historyTokens"), editedTokens: $("#editedTokens"), savedTokens: $("#savedTokens"),
  externalTokens: $("#externalTokens"), projectedTokens: $("#projectedTokens"), budgetNote: $("#budgetNote"),
  budgetRing: $("#budgetRing"), budgetPercent: $("#budgetPercent"), actualUsage: $("#actualUsage"),
  toast: $("#toast"), modal: $("#confirmModal"), idleConfirm: $("#idleConfirm"),
  confirmSave: $("#confirmSave"), cancelSave: $("#cancelSave"), saveSummary: $("#saveSummary"),
};

function fmtNumber(value) { return Number(value || 0).toLocaleString("zh-CN"); }
function fmtBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}
function fmtTime(ms) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(ms)); }
function approxTokens(text) { return Math.ceil(new TextEncoder().encode(String(text || "")).length / 4); }
function editedEntryTokens(entry, text) {
  if (entry.kind === "reasoning") return entry.tokens;
  return approxTokens(text);
}
function currentEntryTokens(entry) {
  return state.edits.has(entry.id) ? editedEntryTokens(entry, currentText(entry)) : entry.tokens;
}

async function api(path, options = {}) {
  if (typeof window.__CONTEXT_STUDIO_MCP_CALL__ === "function") {
    return window.__CONTEXT_STUDIO_MCP_CALL__(path, options);
  }
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error?.message || "Request failed");
    error.code = data.error?.code;
    error.details = data.error?.details;
    throw error;
  }
  return data;
}

function showToast(message, error = false, { centered = false, duration = error ? 8000 : 5000 } = {}) {
  els.toast.textContent = message;
  els.toast.classList.toggle("error", error);
  els.toast.classList.toggle("centered", centered);
  els.toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.add("hidden"), duration);
}

async function loadRollouts() {
  if (state.syncing) return;
  state.syncing = true;
  if (!state.rollouts.length) els.rolloutList.innerHTML = '<div class="empty">正在读取 Codex sessions…</div>';
  try {
    const data = await api("/api/rollouts");
    state.rollouts = data.rollouts;
    renderRollouts();
    await synchronizeCurrentFromIndex();
  } catch (error) {
    els.rolloutList.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  } finally { state.syncing = false; }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function renderRollouts() {
  const q = els.searchInput.value.trim().toLowerCase();
  const byId = new Map(state.rollouts.map((item) => [item.threadId, item]));
  const childrenByParent = new Map();
  for (const item of state.rollouts) {
    if (!item.parentThreadId || !byId.has(item.parentThreadId)) continue;
    if (!childrenByParent.has(item.parentThreadId)) childrenByParent.set(item.parentThreadId, []);
    childrenByParent.get(item.parentThreadId).push(item);
  }
  const roots = state.rollouts.filter((item) => !item.parentThreadId || !byId.has(item.parentThreadId));
  const matches = (item) => `${item.title} ${item.cwd} ${item.threadId} ${item.agentNickname || ""} ${item.agentPath || ""}`.toLowerCase().includes(q);
  const groups = roots.map((root) => ({ root, children: (childrenByParent.get(root.threadId) || []).sort((a, b) => b.mtimeMs - a.mtimeMs) }))
    .filter(({ root, children }) => !q || matches(root) || children.some(matches));
  if (!groups.length) {
    els.rolloutList.innerHTML = '<div class="empty">没有匹配的 rollout</div>';
    return;
  }
  const itemButton = (item, child = false) => {
    const card = `<button class="rollout-item ${child ? "subagent-item" : ""} ${state.current?.path === item.path ? "active" : ""}" data-path="${escapeHtml(item.path)}">
    <div class="title">${escapeHtml(item.title || "未命名线程")}</div>
    <div class="sub"><span><i class="status-dot ${item.status?.idle ? "" : "active"}"></i>${item.status?.idle ? "空闲" : "运行中"}${child ? " · 局部上下文" : ""}</span><span>${fmtTime(item.mtimeMs)}</span></div>
    <div class="sub"><span>${fmtBytes(item.size)}</span><span>${escapeHtml((item.threadId || "").slice(0, 8))}</span></div>
  </button>`;
    return child ? `<div class="subagent-row">${card}</div>` : card;
  };
  els.rolloutList.innerHTML = groups.map(({ root, children }) => {
    const childMatch = q && children.some(matches);
    const expanded = children.length && (state.expandedParents.has(root.threadId) || childMatch);
    return `<div class="thread-group">
      <div class="thread-row">${itemButton(root)}${children.length ? `<button class="subagent-toggle" data-parent="${escapeHtml(root.threadId)}" aria-label="${expanded ? "收起" : "展开"} ${children.length} 个子代理"><span>${expanded ? "▾" : "▸"}</span>${children.length} 个子代理</button>` : ""}</div>
      ${children.length ? `<div class="subagent-list ${expanded ? "" : "hidden"}">${children.filter((child) => !q || matches(child) || matches(root)).map((child) => itemButton(child, true)).join("")}</div>` : ""}
    </div>`;
  }).join("");
  els.rolloutList.querySelectorAll(".rollout-item").forEach((button) => button.addEventListener("click", () => openRollout(button.dataset.path)));
  els.rolloutList.querySelectorAll(".subagent-toggle").forEach((button) => button.addEventListener("click", () => {
    const parent = button.dataset.parent;
    if (state.expandedParents.has(parent)) state.expandedParents.delete(parent); else state.expandedParents.add(parent);
    renderRollouts();
  }));
}

async function openRollout(filePath, force = false) {
  if (!force && (state.edits.size || state.deletions.size) && !confirm("当前修改尚未保存。放弃修改并打开另一个任务？")) return;
  try {
    const data = await api("/api/open", { method: "POST", body: JSON.stringify({ path: filePath }) });
    const indexed = state.rollouts.find((item) => item.path === filePath);
    data.title = indexed?.title || "未命名线程";
    data.isSubagent = Boolean(indexed?.isSubagent);
    data.agentNickname = indexed?.agentNickname || null;
    data.agentPath = indexed?.agentPath || null;
    data.parentThreadId = indexed?.parentThreadId || null;
    state.current = data;
    state.edits.clear();
    state.deletions.clear();
    state.expanded.clear();
    state.page = 1;
    renderRollouts();
    renderCurrent();
    await loadBackups();
  } catch (error) { showToast(error.message, true); }
}

function renderCurrent() {
  const doc = state.current;
  els.emptyEditor.classList.add("hidden");
  els.editorContent.classList.remove("hidden");
  renderStatusOnly();
  renderEntries();
  renderUsage();
}

function renderStatusOnly() {
  const doc = state.current;
  if (!doc) return;
  els.fileTitle.textContent = doc.title || "未命名线程";
  els.filePath.textContent = doc.path;
  els.filePath.title = doc.path;
  els.idleBadge.textContent = doc.status.idle
    ? doc.isSubagent ? "空闲 · 子代理局部上下文" : "空闲，可编辑"
    : `运行中 · ${doc.status.activeTurnId || "active"}${doc.isSubagent ? " · 子代理" : ""}`;
  els.idleBadge.className = `badge ${doc.status.idle ? "ok" : "bad"}`;
  els.threadId.textContent = `Thread ${doc.meta.threadId || "unknown"}`;
  els.validationBadge.innerHTML = doc.stale ? '<span class="badge bad">文件已变化，请重新载入</span>' : doc.validation.ok ? '<span class="badge ok">结构校验通过</span>' : '<span class="badge bad">结构异常</span>';
  els.reloadButton.disabled = false;
  els.backupButton.disabled = !doc.status.idle || doc.stale;
  updateDirtyState();
  if (doc.stale) els.budgetNote.textContent = "预算未更新：磁盘上的 rollout 已发生变化，待重新载入后更新。";
}

function currentText(entry) { return state.edits.has(entry.id) ? state.edits.get(entry.id) : entry.text; }

function renderEntries() {
  if (!state.current) return;
  const query = state.query.toLowerCase();
  const matchedEntries = state.current.entries.filter((entry) => {
    const filterMatch = state.filter === "all"
      || state.filter === entry.kind
      || (state.filter === "active" && entry.inActiveContext)
      || (state.filter === "archived" && entry.archived)
      || (state.filter === "editable" && entry.editable)
      || (state.filter === "tool-output" && ["tool-output", "mcp-call"].includes(entry.kind))
      || (state.filter === "deletable" && entry.deletable)
      || (state.filter === "locked" && !entry.editable && !entry.deletable);
    const searchMatch = !query || `${entry.role} ${entry.toolName || ""} ${currentText(entry)}`.toLowerCase().includes(query);
    return filterMatch && searchMatch;
  });
  if (!matchedEntries.length) {
    els.entryList.innerHTML = '<div class="empty">没有匹配的上下文条目</div>';
    return;
  }
  const totalPages = Math.max(1, Math.ceil(matchedEntries.length / state.pageSize));
  state.page = Math.min(Math.max(1, state.page), totalPages);
  const pageStart = (state.page - 1) * state.pageSize;
  const entries = matchedEntries.slice(pageStart, pageStart + state.pageSize);
  els.entryList.innerHTML = entries.map((entry) => {
    const text = currentText(entry);
    const changed = state.edits.has(entry.id);
    const deleted = state.deletions.has(entry.id);
    const largeCollapsed = entry.editable && !deleted && text.length > 20000 && !state.expanded.has(entry.id);
    const title = ["tool-output", "mcp-call"].includes(entry.kind) ? entry.toolName : entry.role;
    const meta = [entry.sourceLabel, entry.phase, entry.turnId ? `turn ${entry.turnId.slice(0, 8)}` : null, entry.contentPartCount > 1 ? `${entry.contentPartCount} parts` : null].filter(Boolean).join(" · ");
    return `<article class="entry-card ${changed ? "changed" : ""} ${deleted ? "deleted" : ""} ${entry.archived ? "archived" : ""} ${entry.editable || entry.deletable ? "" : "locked"}" data-id="${escapeHtml(entry.id)}">
      <div class="entry-head">
        <div class="entry-identity"><span class="role ${escapeHtml(entry.role)}">${escapeHtml(title)}</span><span class="entry-meta">${escapeHtml(meta)}</span></div>
        <div class="entry-actions"><span class="token-pill">${deleted ? "将删除 · " : ""}≈ ${fmtNumber(currentEntryTokens(entry))} tokens（估计）</span>${changed ? '<button class="mini-button restore">恢复文本</button>' : ""}${entry.deletable ? `<button class="mini-button delete">${deleted ? "撤销删除" : "删除整项"}</button>` : ""}</div>
      </div>
      ${entry.textOmitted
        ? `<div class="locked-text">${escapeHtml(text)}\n\n… 已省略 ${fmtNumber(Math.max(0, entry.textLength - text.length))} 个字符 …</div><div class="lock-note">大型内容按需加载以保持界面流畅 · <button class="mini-button load-full">加载完整内容</button></div>`
        : entry.editable && !largeCollapsed
        ? `<textarea spellcheck="false" aria-label="编辑 ${escapeHtml(title)}">${escapeHtml(text)}</textarea>`
        : largeCollapsed
          ? `<div class="locked-text">${escapeHtml(text.slice(0, 4000))}\n\n… 已折叠 ${fmtNumber(text.length - 4000)} 个字符 …</div><div class="lock-note">大型输出已折叠以保持界面流畅 · <button class="mini-button expand">加载完整内容并编辑</button></div>`
        : `<div class="locked-text">${escapeHtml(text)}</div><div class="lock-note">🔒 ${escapeHtml(entry.lockedReason || "结构上下文只读")}</div>`}
    </article>`;
  }).join("") + renderPagination(matchedEntries.length, totalPages);

  els.entryList.querySelectorAll(".entry-card").forEach((card) => {
    const entry = state.current.entries.find((item) => item.id === card.dataset.id);
    const textarea = card.querySelector("textarea");
    if (textarea) textarea.addEventListener("input", () => {
      if (textarea.value === entry.text) state.edits.delete(entry.id);
      else state.edits.set(entry.id, textarea.value);
      card.classList.toggle("changed", state.edits.has(entry.id));
      card.querySelector(".token-pill").textContent = `≈ ${fmtNumber(editedEntryTokens(entry, textarea.value))} tokens（估计）`;
      updateDirtyState();
      renderBudget();
    });
    card.querySelector(".restore")?.addEventListener("click", () => {
      state.edits.delete(entry.id);
      renderEntries();
      updateDirtyState();
      renderBudget();
    });
    card.querySelector(".delete")?.addEventListener("click", () => {
      if (state.deletions.has(entry.id)) state.deletions.delete(entry.id);
      else { state.deletions.add(entry.id); state.edits.delete(entry.id); }
      renderEntries(); updateDirtyState(); renderBudget();
    });
    card.querySelector(".expand")?.addEventListener("click", () => {
      state.expanded.add(entry.id);
      renderEntries();
      const expandedCard = els.entryList.querySelector(`[data-id="${CSS.escape(entry.id)}"]`);
      expandedCard?.scrollIntoView({ block: "center" });
    });
    card.querySelector(".load-full")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = "加载中…";
      try {
        const result = await api("/api/entry", {
          method: "POST",
          body: JSON.stringify({ path: state.current.path, entryId: entry.id }),
        });
        entry.text = result.text;
        entry.textOmitted = false;
        state.expanded.add(entry.id);
        renderEntries();
        els.entryList.querySelector(`[data-id="${CSS.escape(entry.id)}"]`)?.scrollIntoView({ block: "center" });
      } catch (error) {
        showToast(error.message, true);
        button.disabled = false;
        button.textContent = "重试加载";
      }
    });
  });
  bindPagination(totalPages);
}

function renderPagination(totalItems, totalPages) {
  return `<nav class="pagination" aria-label="上下文分页">
    <div class="pagination-summary">第 <strong>${state.page}</strong> / ${totalPages} 页 · 共 ${fmtNumber(totalItems)} 条</div>
    <div class="pagination-actions">
      <button class="page-button" data-page-action="first" ${state.page === 1 ? "disabled" : ""}>« 第一页</button>
      <button class="page-button" data-page-action="prev" ${state.page === 1 ? "disabled" : ""}>‹ 上一页</button>
      <label class="page-jump">跳到 <input id="pageInput" class="page-input" type="number" min="1" max="${totalPages}" value="${state.page}" aria-label="输入页码" /> 页</label>
      <button class="page-button" data-page-action="next" ${state.page === totalPages ? "disabled" : ""}>下一页 ›</button>
      <button class="page-button" data-page-action="last" ${state.page === totalPages ? "disabled" : ""}>最后一页 »</button>
    </div>
  </nav>`;
}

function bindPagination(totalPages) {
  const go = (page) => {
    state.page = Math.min(Math.max(1, page), totalPages);
    renderEntries();
    els.entryList.scrollTop = 0;
  };
  els.entryList.querySelector('[data-page-action="first"]')?.addEventListener("click", () => go(1));
  els.entryList.querySelector('[data-page-action="prev"]')?.addEventListener("click", () => go(state.page - 1));
  els.entryList.querySelector('[data-page-action="next"]')?.addEventListener("click", () => go(state.page + 1));
  els.entryList.querySelector('[data-page-action="last"]')?.addEventListener("click", () => go(totalPages));
  const pageInput = els.entryList.querySelector("#pageInput");
  pageInput?.addEventListener("change", (event) => go(Number(event.target.value)));
  pageInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); go(Number(event.currentTarget.value)); }
  });
}

function renderUsage() {
  const usage = state.current?.usage;
  const last = usage?.last_token_usage;
  if (!last) els.actualUsage.textContent = "该 rollout 没有可用的 token_count 事件。";
  else {
    const reference = usage.reference_input_usage || last;
    const input = Math.max(0, Number(reference.input_tokens) || 0);
    const cached = Math.min(input, Math.max(0, Number(reference.cached_input_tokens) || 0));
    const uncached = Math.max(0, input - cached);
    const hitRate = input ? `${((cached / input) * 100).toFixed(1)}%` : "暂无官方统计";
    const totalUsage = usage.total_token_usage;
    const totalInput = Math.max(0, Number(totalUsage?.input_tokens) || 0);
    const totalCached = Math.min(totalInput, Math.max(0, Number(totalUsage?.cached_input_tokens) || 0));
    const totalHitRate = totalInput ? `${((totalCached / totalInput) * 100).toFixed(1)}%` : "暂无官方统计";
    els.actualUsage.innerHTML = `最近请求输入 <strong>${fmtNumber(input)}</strong><br>缓存命中 <strong>${fmtNumber(cached)}</strong><br>非缓存输入 <strong>${fmtNumber(uncached)}</strong><br>缓存命中率 <strong>${hitRate}</strong><br>会话累计命中率 <strong>${totalHitRate}</strong><br>该次模型输出 <strong>${fmtNumber(reference.output_tokens)}</strong><br>模型窗口 <strong>${fmtNumber(usage.model_context_window || state.current.meta.contextWindow)}</strong>`;
  }
  renderBudget();
}

function renderBudget() {
  if (!state.current) return;
  const archival = state.current.tokenStats.allVisibleTokens;
  let archivalEdited = 0;
  for (const entry of state.current.entries) {
    if (state.deletions.has(entry.id)) continue;
    archivalEdited += currentEntryTokens(entry);
  }
  const activeOriginal = state.current.contextStats?.activeVisibleTokens ?? archival;
  const activeEntryOriginal = state.current.entries
    .filter((entry) => entry.inActiveContext)
    .reduce((sum, entry) => sum + entry.tokens, 0);
  let activeEdited = Math.max(0, activeOriginal - activeEntryOriginal);
  for (const entry of state.current.entries) {
    if (!entry.inActiveContext) continue;
    if (state.deletions.has(entry.id)) continue;
    activeEdited += currentEntryTokens(entry);
  }
  const saved = Math.max(0, activeOriginal - activeEdited);
  const reference = state.current.usage?.reference_input_usage || state.current.usage?.last_token_usage;
  const measuredInput = Number(reference?.input_tokens) || 0;
  const external = measuredInput ? Math.max(0, measuredInput - activeOriginal) : null;
  const total = measuredInput ? Math.max(0, measuredInput + activeEdited - activeOriginal) : activeEdited;
  const windowSize = state.current.usage?.model_context_window || state.current.meta.contextWindow || 0;
  const percent = windowSize ? Math.min(100, (total / windowSize) * 100) : 0;
  const archivalChanged = archivalEdited !== archival;
  els.historyTokens.textContent = archivalChanged ? `${fmtNumber(archival)} → ${fmtNumber(archivalEdited)}` : fmtNumber(archival);
  els.editedTokens.textContent = fmtNumber(activeEdited);
  els.savedTokens.textContent = `${fmtNumber(saved)}${saved && activeOriginal ? ` (${((saved / activeOriginal) * 100).toFixed(1)}%)` : ""}`;
  els.externalTokens.textContent = external === null ? "不可校准" : `≈ ${fmtNumber(external)}`;
  els.projectedTokens.textContent = fmtNumber(total);
  els.budgetPercent.textContent = windowSize ? `${percent.toFixed(1)}%` : "—";
  els.budgetRing.style.setProperty("--percent", percent);
  const inactiveChanges = [...new Set([...state.edits.keys(), ...state.deletions])]
    .filter((id) => !state.current.entries.find((entry) => entry.id === id)?.inActiveContext).length;
  if (state.current.stale) {
    els.budgetNote.textContent = "预算未更新：磁盘上的 rollout 已发生变化，待重新载入后更新。";
  } else if (!measuredInput) {
    els.budgetNote.textContent = "输入预算未校准：没有可用的真实 token_count，待 Codex 完成下一次真实请求后校准。";
  } else {
    els.budgetNote.textContent = `以最近一次真实输入 ${fmtNumber(measuredInput)} tokens 校准；外部估算包含系统提示、工具 schema、插件/skill 注入及近似误差。${inactiveChanges ? ` 另有 ${inactiveChanges} 项修改位于 compact 前：完整日志已更新，但不会改变当前输入圆环。` : ""}`;
  }
}

function updateDirtyState() {
  const dirty = state.edits.size > 0 || state.deletions.size > 0;
  els.dirtyBadge.classList.toggle("hidden", !dirty);
  els.saveButton.disabled = !dirty || !state.current?.status.idle || !state.current?.validation.ok || state.current?.stale;
}

function openSaveModal() {
  if (!state.edits.size && !state.deletions.size) return;
  let before = 0; let after = 0;
  for (const entry of state.current.entries) {
    before += entry.tokens;
    if (!state.deletions.has(entry.id)) after += currentEntryTokens(entry);
  }
  els.saveSummary.innerHTML = `文本修改：<strong>${state.edits.size}</strong><br>整项删除：<strong>${state.deletions.size}</strong><br>历史估算：<strong>${fmtNumber(before)}</strong> → <strong>${fmtNumber(after)}</strong> tokens<br>线程：<strong>${escapeHtml(state.current.title)}</strong>`;
  els.idleConfirm.checked = false;
  els.confirmSave.disabled = true;
  els.modal.classList.remove("hidden");
}

async function save() {
  els.confirmSave.disabled = true;
  const patches = [...state.edits].map(([id, text]) => ({ id, text }));
  const deletions = [...state.deletions];
  try {
    const result = await api("/api/save", { method: "POST", body: JSON.stringify({ path: state.current.path, expectedHash: state.current.hash, patches, deletions }) });
    els.modal.classList.add("hidden");
    state.current = result.summary;
    state.current.title = state.rollouts.find((item) => item.path === state.current.path)?.title || "未命名线程";
    state.edits.clear();
    state.deletions.clear();
    renderCurrent();
    await loadRollouts();
    await loadBackups();
    if (result.staged) {
      showToast("Edit staged. Codex is archiving, committing, and hot reloading the task...", false, { duration: 7000 });
      return;
    }
    showToast(`保存成功。备份：${result.backupPath}`);
  } catch (error) {
    els.modal.classList.add("hidden");
    showToast(`${error.code || "SAVE_FAILED"}: ${error.message}`, true);
  }
}

async function loadBackups() {
  if (!state.current) return;
  try {
    const data = await api(`/api/backups?path=${encodeURIComponent(state.current.path)}`);
    state.backups = data.backups;
    renderBackups();
  } catch (error) { showToast(error.message, true); }
}

function renderBackups() {
  if (!state.backups.length) {
    els.backupVersions.innerHTML = '<option value="">暂无备份</option>';
    els.backupVersions.disabled = true; els.restoreButton.disabled = true; return;
  }
  els.backupVersions.innerHTML = state.backups.map((backup) => `<option value="${escapeHtml(backup.id)}">${backup.kind === "original" ? "初始版本" : "手动备份"} · ${new Date(backup.createdAt).toLocaleString("zh-CN")} · ${fmtBytes(backup.size)}</option>`).join("");
  els.backupVersions.disabled = false;
  els.restoreButton.disabled = Boolean(state.edits.size || state.deletions.size || !state.current?.status.idle || state.current?.stale);
}

async function createBackup() {
  try {
    const data = await api("/api/backups", { method: "POST", body: JSON.stringify({ path: state.current.path, expectedHash: state.current.hash }) });
    state.backups = data.backups; renderBackups(); showToast("手动备份已创建");
  } catch (error) { showToast(`${error.code || "BACKUP_FAILED"}: ${error.message}`, true); }
}

async function restoreSelectedBackup() {
  const backupId = els.backupVersions.value;
  if (!backupId || !state.current) return;
  if (!confirm("恢复会覆盖当前 rollout，且不会自动备份当前状态。确定继续？")) return;
  try {
    const result = await api("/api/restore", { method: "POST", body: JSON.stringify({ path: state.current.path, expectedHash: state.current.hash, threadId: state.current.meta.threadId, backupId }) });
    result.summary.title = state.current.title; state.current = result.summary; state.edits.clear(); state.deletions.clear();
    renderCurrent(); await loadRollouts(); await loadBackups();
    if (result.staged) {
      showToast("Restore staged. Codex is hot reloading the selected backup...", false, { centered: true, duration: 7000 });
      return;
    }
    showToast("备份版本已恢复", false, { centered: true, duration: 1600 });
  } catch (error) { showToast(`${error.code || "RESTORE_FAILED"}: ${error.message}`, true); }
}

async function synchronizeCurrentFromIndex() {
  if (!state.current) return;
  const indexed = state.rollouts.find((item) => item.path === state.current.path);
  if (!indexed) return;
  state.current.title = indexed.title || state.current.title;
  state.current.isSubagent = Boolean(indexed.isSubagent);
  state.current.agentNickname = indexed.agentNickname || null;
  state.current.agentPath = indexed.agentPath || null;
  state.current.parentThreadId = indexed.parentThreadId || null;
  state.current.status = indexed.status;
  const changed = indexed.mtimeMs !== state.current.mtimeMs || indexed.size !== state.current.size;
  if (changed) {
    if (indexed.status.idle && !state.edits.size && !state.deletions.size) await openRollout(state.current.path, true);
    else { state.current.stale = true; renderStatusOnly(); }
  } else { renderStatusOnly(); }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("context-studio-theme", theme);
  els.themeToggle.textContent = theme === "light" ? "☾ 暗色" : "☀ 亮色";
}

els.refreshButton.addEventListener("click", loadRollouts);
els.searchInput.addEventListener("input", renderRollouts);
els.entrySearch.addEventListener("input", () => { state.query = els.entrySearch.value; state.page = 1; renderEntries(); });
els.reloadButton.addEventListener("click", () => state.current && openRollout(state.current.path, true));
els.backupButton.addEventListener("click", createBackup);
els.restoreButton.addEventListener("click", restoreSelectedBackup);
els.backupVersions.addEventListener("change", renderBackups);
els.themeToggle.addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"));
els.fullscreenButton?.addEventListener("click", async () => {
  try {
    if (typeof window.__CONTEXT_STUDIO_REQUEST_FULLSCREEN__ !== "function") throw new Error("当前页面不是 Codex 嵌入式应用");
    await window.__CONTEXT_STUDIO_REQUEST_FULLSCREEN__();
  } catch (error) { showToast(`无法切换全屏：${error.message}`, true); }
});
if (window.__CONTEXT_STUDIO_EXTERNAL__) {
  els.browserButton?.classList.add("hidden");
  els.fullscreenButton?.classList.add("hidden");
} else {
  els.browserButton?.addEventListener("click", async () => {
    try {
      if (typeof window.__CONTEXT_STUDIO_OPEN_BROWSER__ !== "function") throw new Error("浏览器工作台仅在 Codex MCP App 中可用");
      await window.__CONTEXT_STUDIO_OPEN_BROWSER__();
    } catch (error) { showToast(`无法打开浏览器工作台：${error.message}`, true); }
  });
}
els.saveButton.addEventListener("click", openSaveModal);
els.cancelSave.addEventListener("click", () => els.modal.classList.add("hidden"));
els.idleConfirm.addEventListener("change", () => { els.confirmSave.disabled = !els.idleConfirm.checked; });
els.confirmSave.addEventListener("click", save);
document.querySelectorAll(".segment").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".segment").forEach((item) => item.classList.remove("active"));
  button.classList.add("active"); state.filter = button.dataset.filter; state.page = 1; renderEntries();
}));
window.addEventListener("beforeunload", (event) => { if (state.edits.size || state.deletions.size) { event.preventDefault(); event.returnValue = ""; } });

applyTheme(localStorage.getItem("context-studio-theme") || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));
loadRollouts();
setInterval(loadRollouts, 1500);
