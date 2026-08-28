// Wires GET /console/summary into the bento dashboard (CONSOLE_SPEC.md §4):
// one round trip, poll every 30s. Every DOM write uses textContent/
// createElement, never innerHTML — summary fields (script hooks, suggested
// titles) ultimately trace back to LLM output and third-party feed text,
// which CLAUDE.md's NEVER block treats as data, not something to trust.
import { dispatchRun, getSummary, setKillswitch } from "../lib/api.ts";
import { startPolling } from "./poll.ts";
import { renderKeyList } from "./keys.ts";
import { renderMcpTokenList } from "./mcp-tokens.ts";
import { redirectIfUnauthorized } from "../lib/session-guard.ts";
import { formatBytes, formatRelativeTime } from "../lib/format.ts";
import { LIVE_STATUS_TEXT } from "../lib/status-style.ts";
import type { AuditFlagCount, ConsoleSummary, ExportListItem, FootageHealthEntry, PipelinePulse, QuotaSnapshot, TtsStatus } from "../lib/types.ts";

const POLL_INTERVAL_MS = 30_000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setText(id: string, value: string): void {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}

function showApiError(show: boolean): void {
  document.querySelector<HTMLElement>("[data-console-api-error]")?.classList.toggle("hidden", !show);
}

function renderPulse(pulse: PipelinePulse): void {
  setText("pulse-signals", String(pulse.signalsObserved));
  setText("pulse-scripted", String(pulse.scripted));
  setText("pulse-rendered", String(pulse.rendered));
  setText("pulse-exported", String(pulse.exported));
  setText("pulse-live-stage", pulse.liveRun ? `live: ${pulse.liveRun.stage}` : "");
  setText("pulse-next-cron", pulse.nextCronAt ? formatRelativeTime(pulse.nextCronAt) : "unscheduled");
}

function renderExportPreview(listId: string, items: ExportListItem[], emptyLabel: string): void {
  const list = document.getElementById(listId);
  if (!list) return;
  list.replaceChildren();
  if (items.length === 0) {
    list.appendChild(el("li", "text-mercury/40", emptyLabel));
    return;
  }
  for (const item of items.slice(0, 5)) {
    const row = el("li", "flex items-center justify-between gap-2");
    row.appendChild(el("span", "truncate", item.suggestedTitle));
    row.appendChild(el("span", "shrink-0 text-mercury/40", formatRelativeTime(item.createdAt)));
    list.appendChild(row);
  }
}

function renderAuditFlags(flags: AuditFlagCount[]): void {
  const list = document.getElementById("audit-flags");
  if (!list) return;
  list.replaceChildren();
  if (flags.length === 0) {
    list.appendChild(el("li", "text-mercury/40", "No flags in the last 7 days."));
    return;
  }
  for (const flag of flags) {
    const row = el("li", "flex items-center justify-between gap-2");
    row.appendChild(el("span", "truncate", flag.reason));
    row.appendChild(el("span", "shrink-0 rounded-full bg-rose/15 px-2 py-0.5 text-rose", String(flag.count)));
    list.appendChild(row);
  }
}

function renderFootageHealth(entries: FootageHealthEntry[]): void {
  const list = document.getElementById("footage-health");
  if (!list) return;
  list.replaceChildren();
  if (entries.length === 0) {
    list.appendChild(el("li", "text-mercury/40", "No footage sources tracked yet."));
    return;
  }
  for (const entry of entries) {
    const row = el("li", "flex items-center justify-between gap-2");
    row.appendChild(el("span", "truncate", entry.game));
    row.appendChild(
      el(
        "span",
        `shrink-0 ${entry.lowInventory ? "text-rose" : "text-mercury/40"}`,
        `${entry.segmentCount} clips`,
      ),
    );
    list.appendChild(row);
  }
}

function renderQuota(q: QuotaSnapshot): void {
  const meters: [id: string, used: string, ceiling: string, pct: number][] = [
    ["quota-groq", String(q.groqRequestsToday), String(q.groqRequestsCeiling), pct(q.groqRequestsToday, q.groqRequestsCeiling)],
    ["quota-youtube", String(q.youtubeUnitsToday), String(q.youtubeUnitsCeiling), pct(q.youtubeUnitsToday, q.youtubeUnitsCeiling)],
    [
      "quota-actions",
      String(q.actionsMinutesToday),
      String(q.actionsMinutesCeiling),
      pct(q.actionsMinutesToday, q.actionsMinutesCeiling),
    ],
    ["quota-kv", formatBytes(q.kvStorageBytesUsed), formatBytes(q.kvStorageBytesCeiling), pct(q.kvStorageBytesUsed, q.kvStorageBytesCeiling)],
  ];
  for (const [id, used, ceiling, p] of meters) {
    setText(`${id}-text`, `${used} / ${ceiling}`);
    const fill = document.getElementById(`${id}-fill`);
    if (fill) fill.style.width = `${p}%`;
  }
}

function pct(used: number, ceiling: number): number {
  return ceiling > 0 ? Math.min(100, Math.round((used / ceiling) * 100)) : 0;
}

function renderTtsStatus(ttsStatus: TtsStatus): void {
  const node = document.getElementById("tts-status-dot");
  if (!node) return;
  node.className = `font-mono text-xs ${LIVE_STATUS_TEXT[ttsStatus.status]}`;
  node.textContent = `${ttsStatus.status} · checked ${formatRelativeTime(ttsStatus.lastCheckedAt)}`;
}

function renderSettingsSummary(summary: ConsoleSummary): void {
  const node = document.getElementById("settings-summary");
  if (!node) return;
  node.replaceChildren();
  const { compiled } = summary.settings;
  const rows: [string, string][] = [
    ["Focus games", compiled.focusGames.length ? compiled.focusGames.join(", ") : "all"],
    ["Voice pool", compiled.voicePool ? `${compiled.voicePool.length} selected` : "default pool"],
    ["Diversity mode", compiled.diversityMode ? "on" : "off"],
  ];
  for (const [label, value] of rows) {
    const row = el("div", "flex justify-between gap-2");
    row.appendChild(el("span", "text-mercury/50", label));
    row.appendChild(el("span", "text-mercury", value));
    node.appendChild(row);
  }
}

function renderKillswitch(enabled: boolean): void {
  const button = document.getElementById("killswitch-toggle");
  if (!(button instanceof HTMLButtonElement)) return;
  button.setAttribute("aria-pressed", String(enabled));
  button.textContent = enabled ? "Resume pipeline" : "Halt pipeline";
  button.classList.toggle("border-rose/40", !enabled);
  button.classList.toggle("text-rose", !enabled);
  button.classList.toggle("border-oxide/40", enabled);
  button.classList.toggle("text-oxide", enabled);
}

let latestKillswitchState = false;

// Every list on this dashboard starts as a static "Loading…" placeholder
// (index.astro). If the fetch never succeeds, that placeholder must not be
// left stuck — an unresolved "Loading…" forever reads as broken, and a bare
// "0 / 1" quota meter could be misread as a real, unusually low number.
// Neither is honest; this makes the unavailable state explicit everywhere.
function showUnavailableState(): void {
  for (const id of ["ready-preview", "reviewed-preview", "audit-flags", "footage-health"]) {
    const list = document.getElementById(id);
    if (list) list.replaceChildren(el("li", "text-mercury/40", "Unavailable."));
  }
  setText("ready-count", "–");
  setText("settings-summary", "Unavailable.");
  const keyList = document.getElementById("key-list");
  if (keyList) keyList.replaceChildren(el("li", "text-mercury/40", "Unavailable."));
  const mcpTokenList = document.getElementById("mcp-token-list");
  if (mcpTokenList) mcpTokenList.replaceChildren(el("li", "text-mercury/40", "Unavailable."));
  for (const id of ["quota-groq", "quota-youtube", "quota-actions", "quota-kv"]) {
    setText(`${id}-text`, "–");
  }
  setText("tts-status-dot", "unavailable");
  setText("pulse-signals", "–");
  setText("pulse-scripted", "–");
  setText("pulse-rendered", "–");
  setText("pulse-exported", "–");
  setText("pulse-next-cron", "–");
}

async function refresh(): Promise<void> {
  const result = await getSummary();
  if (!result.ok) {
    if (redirectIfUnauthorized(result.error)) return;
    showApiError(true);
    showUnavailableState();
    return;
  }
  showApiError(false);
  const summary = result.value;
  renderPulse(summary.pipelinePulse);
  renderExportPreview("ready-preview", summary.readyForReview, "Nothing waiting for review.");
  setText("ready-count", String(summary.readyForReview.length));
  renderExportPreview("reviewed-preview", summary.reviewed, "Nothing reviewed yet.");
  renderAuditFlags(summary.auditFlags);
  renderFootageHealth(summary.footageHealth);
  renderQuota(summary.quota);
  renderTtsStatus(summary.ttsStatus);
  renderSettingsSummary(summary);
  renderKeyList("key-list", summary.keys);
  renderMcpTokenList("mcp-token-list", summary.mcpTokens, () => void refresh());
  latestKillswitchState = summary.killswitch.enabled;
  renderKillswitch(latestKillswitchState);
}

function wireKillswitch(): void {
  const button = document.getElementById("killswitch-toggle");
  if (!(button instanceof HTMLButtonElement)) return;
  button.addEventListener("click", () => {
    void (async () => {
      button.disabled = true;
      const result = await setKillswitch(!latestKillswitchState);
      button.disabled = false;
      if (result.ok) {
        latestKillswitchState = result.value.enabled;
        renderKillswitch(latestKillswitchState);
      }
    })();
  });
}

function wireDispatch(): void {
  const button = document.getElementById("dispatch-run-button");
  if (!(button instanceof HTMLButtonElement)) return;
  button.addEventListener("click", () => {
    void (async () => {
      const original = button.textContent;
      button.disabled = true;
      button.textContent = "Dispatching…";
      // POST /console/dispatch is rate-limited server-side to 10/hour
      // (ARCHITECTURE.md §6) — this button doesn't duplicate that limit
      // client-side, it just surfaces whatever the server decides.
      const result = await dispatchRun();
      button.textContent = result.ok ? "Dispatched" : `Failed: ${result.error.message}`;
      if (result.ok) void refresh();
      setTimeout(() => {
        button.disabled = false;
        button.textContent = original ?? "Run now";
      }, 3000);
    })();
  });
}

export function initDashboard(): void {
  wireKillswitch();
  wireDispatch();
  startPolling(refresh, POLL_INTERVAL_MS);
}
