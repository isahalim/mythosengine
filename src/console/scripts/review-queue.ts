// Full review/export queue (CONSOLE_SPEC.md §4). Download is a plain same-
// origin <a href> (the browser sends the session cookie itself — no fetch
// needed); mark-reviewed/discard are one-shot POSTs, never retried
// automatically (a retried discard could double-fire against a second
// export if the id were ever reused — see api.ts's `send()` comment).
import { discardExport, downloadExportUrl, listExports, markExportReviewed } from "../lib/api.ts";
import { formatBytes, formatDuration, formatRelativeTime } from "../lib/format.ts";
import { EXPORT_STATUS_PILL } from "../lib/status-style.ts";
import { redirectIfUnauthorized } from "../lib/session-guard.ts";
import type { ExportListItem, ExportStatus } from "../lib/types.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildRow(item: ExportListItem, onChanged: () => void): HTMLLIElement {
  const row = el("li", "glass-card flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between");

  const left = el("div", "flex min-w-0 flex-col gap-1");
  left.appendChild(el("p", "truncate font-body text-sm font-medium text-bone", item.suggestedTitle));
  const meta = el("div", "flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-mercury/60");
  const metaParts = [
    item.footageGame,
    item.ttsVoice,
    item.durationS !== null ? formatDuration(item.durationS) : null,
    formatBytes(item.sizeBytes),
    formatRelativeTime(item.createdAt),
  ].filter((v): v is string => v !== null);
  for (const part of metaParts) meta.appendChild(el("span", undefined, part));
  left.appendChild(meta);
  row.appendChild(left);

  const right = el("div", "flex shrink-0 flex-wrap items-center gap-2");

  const pill = el(
    "span",
    `inline-flex w-fit items-center rounded-full border px-2.5 py-0.5 font-mono text-xs uppercase tracking-wide ${EXPORT_STATUS_PILL[item.status]}`,
    item.status.replace(/_/g, " "),
  );
  right.appendChild(pill);

  const download = document.createElement("a");
  download.href = downloadExportUrl(item.id);
  download.className = "rounded-full border border-mercury/20 px-3.5 py-1.5 font-body text-xs text-mercury transition-colors hover:border-sodium/50 hover:text-sodium";
  download.textContent = "Download";
  right.appendChild(download);

  // Both statuses, not just ready_for_review. Downloading flips an export to
  // "downloaded", and gating the actions on the earlier status stranded it:
  // no Mark reviewed, no Discard, nothing to do but wait for it to expire —
  // and marking something reviewed *after* watching it is the whole workflow.
  // The server already accepts either transition; this was only a UI gate.
  if (item.status === "ready_for_review" || item.status === "downloaded") {
    const reviewBtn = document.createElement("button");
    reviewBtn.type = "button";
    reviewBtn.className = "rounded-full border border-oxide/40 px-3.5 py-1.5 font-body text-xs text-oxide transition-colors hover:bg-oxide/10";
    reviewBtn.textContent = "Mark reviewed";
    reviewBtn.addEventListener("click", () => {
      void (async () => {
        reviewBtn.disabled = true;
        const result = await markExportReviewed(item.id);
        if (result.ok) onChanged();
        else reviewBtn.disabled = false;
      })();
    });
    right.appendChild(reviewBtn);

    const discardBtn = document.createElement("button");
    discardBtn.type = "button";
    discardBtn.className = "rounded-full border border-rose/40 px-3.5 py-1.5 font-body text-xs text-rose transition-colors hover:bg-rose/10";
    discardBtn.textContent = "Discard";
    discardBtn.addEventListener("click", () => {
      void (async () => {
        discardBtn.disabled = true;
        const result = await discardExport(item.id);
        if (result.ok) onChanged();
        else discardBtn.disabled = false;
      })();
    });
    right.appendChild(discardBtn);
  }

  row.appendChild(right);
  return row;
}

async function loadStatus(status: ExportStatus): Promise<void> {
  const list = document.getElementById("export-list");
  const errorBanner = document.querySelector<HTMLElement>("[data-console-api-error]");
  if (!list) return;

  const result = await listExports(status);
  if (!result.ok) {
    if (redirectIfUnauthorized(result.error)) return;
    errorBanner?.classList.remove("hidden");
    list.replaceChildren(el("li", "text-sm text-mercury/50", "Unavailable."));
    return;
  }
  errorBanner?.classList.add("hidden");

  list.replaceChildren();
  if (result.value.length === 0) {
    list.appendChild(el("li", "text-sm text-mercury/50", "Nothing here."));
    return;
  }
  for (const item of result.value) {
    list.appendChild(buildRow(item, () => void loadStatus(status)));
  }
}

export function initReviewQueue(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>("[data-status-tab]");
  let activeStatus: ExportStatus = "ready_for_review";

  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      const status = tab.dataset.statusTab as ExportStatus | undefined;
      if (!status) return;
      activeStatus = status;
      for (const other of tabs) {
        const isActive = other === tab;
        other.setAttribute("aria-selected", String(isActive));
        other.classList.toggle("border-sodium/50", isActive);
        other.classList.toggle("text-sodium", isActive);
        other.classList.toggle("border-mercury/20", !isActive);
        other.classList.toggle("text-mercury/60", !isActive);
      }
      void loadStatus(activeStatus);
    });
  }

  void loadStatus(activeStatus);
}
