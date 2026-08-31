// The guided run (plan v2 §7 steps 4 and 5): the waiting screen the
// operator sits in front of while the agents work, and the review handoff
// at the end of it.
//
// Two rules this file exists to keep:
//
// 1. **Nothing on screen is invented.** Every stage, status and video comes
//    from a `runs`/`scripts`/`renders`/`exports` row (src/server/console/runs.ts).
//    There is no synthesized percentage and no estimated finish time, and a
//    run that was recorded but never triggered says exactly that instead of
//    spinning forever (CLAUDE.md's NEVER block).
// 2. **The montage is a preview, and says so.** Its clips come from Pexels,
//    searched for the script's own keywords, and they are not the footage
//    the video is rendered from — that comes from the maintained library.
//    Every clip carries its Pexels attribution and the "preview" label.
import { discardExport, dispatchRun, downloadExportUrl, getRunMontage, getRunProgress, listRuns, markExportReviewed } from "../lib/api.ts";
import { formatBytes, formatDuration, formatRelativeTime } from "../lib/format.ts";
import { redirectIfUnauthorized } from "../lib/session-guard.ts";
import { setRunStep } from "../lib/step-rail.ts";
import { startPolling } from "./poll.ts";
import type { MontageClip, RunProgress, RunStatus, RunVideo } from "../lib/types.ts";

/** Fast enough that a stage transition feels live, slow enough to stay inside ARCHITECTURE.md §10's read budget for a screen someone leaves open. */
const PROGRESS_POLL_MS = 4_000;
/** The montage only changes when a new script lands, which is minutes apart — and each poll can reach Pexels for a keyword it has not cached. */
const MONTAGE_POLL_MS = 20_000;
/** How long one clip holds before the crossfade. Long enough to read the keyword, short enough that a 4-minute wait is not four clips. */
const CLIP_HOLD_MS = 5_500;
const CROSSFADE_MS = 700;

const RUN_STATUS_TEXT: Record<RunStatus, string> = {
  not_triggered: "Recorded, not started",
  queued: "Queued",
  running: "Working",
  succeeded: "Finished",
  failed: "Failed",
};

const RUN_STATUS_PILL: Record<RunStatus, string> = {
  not_triggered: "border-mercury/25 text-mercury/60",
  queued: "border-mercury/25 text-mercury/70",
  running: "border-sodium/40 text-sodium",
  succeeded: "border-oxide/40 text-oxide",
  failed: "border-rose/40 text-rose",
};

const STAGE_DOT: Record<string, string> = {
  running: "bg-sodium animate-pulse",
  succeeded: "bg-oxide",
  failed: "bg-rose",
  skipped: "bg-mercury/30",
  queued: "bg-mercury/30",
};

const STAGE_LABEL: Record<string, string> = {
  dispatch: "Dispatch",
  research: "Research",
  script: "Script",
  critic: "Critic",
  footage_select: "Footage",
  tts: "Voice",
  render: "Render",
  export: "Package",
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * One video card's montage.
 *
 * Two stacked layers so a clip can cross-fade into the next rather than cut
 * — the point of the screen is that the film appears to assemble itself,
 * and a hard cut every five seconds reads as a slideshow. Under
 * `prefers-reduced-motion` the whole cycle is replaced by a still grid of
 * the same clips' thumbnails: same information, no movement.
 */
class MontagePlayer {
  private clips: MontageClip[] = [];
  private index = 0;
  private front = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly layers: HTMLVideoElement[];
  private readonly caption: HTMLElement;
  private readonly still: HTMLElement;
  private readonly reduced = prefersReducedMotion();

  // Workers' ambient DOM types (worker-configuration.d.ts) give Element a
  // one-argument `append`, so every insertion here uses `appendChild` — the
  // same call every other console script uses.
  constructor(root: HTMLElement) {
    this.layers = [0, 1].map(() => {
      const video = document.createElement("video");
      video.className = "absolute inset-0 h-full w-full object-cover opacity-0 transition-opacity duration-700";
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = "metadata";
      root.appendChild(video);
      return video;
    });

    this.still = el("div", "absolute inset-0 hidden grid-cols-2 gap-1 p-1");
    root.appendChild(this.still);

    this.caption = el(
      "div",
      "pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-0.5 bg-gradient-to-t from-mercury/70 to-transparent px-3 pb-2 pt-8 text-left opacity-0 transition-opacity duration-500",
    );
    root.appendChild(this.caption);
  }

  update(clips: MontageClip[]): void {
    // Same clips, same cycle: re-seeding on every 4s poll would restart the
    // fade and the montage would never advance past its first clip.
    const unchanged = clips.length === this.clips.length && clips.every((clip, i) => clip.id === this.clips[i]?.id && clip.keyword === this.clips[i]?.keyword);
    if (unchanged) return;

    this.clips = clips;
    this.index = 0;
    if (clips.length === 0) return;

    if (this.reduced) {
      this.renderStill();
      return;
    }
    this.show(clips[0]);
    this.schedule();
  }

  private renderStill(): void {
    this.still.replaceChildren();
    this.still.classList.remove("hidden");
    this.still.classList.add("grid");
    for (const clip of this.clips.slice(0, 4)) {
      const image = document.createElement("img");
      image.src = clip.thumbnailUrl;
      image.alt = `Pexels preview clip for “${clip.keyword}”, by ${clip.photographer}`;
      image.loading = "lazy";
      image.className = "h-full w-full rounded-lg object-cover";
      this.still.appendChild(image);
    }
    this.setCaption(this.clips[0]);
  }

  private setCaption(clip: MontageClip): void {
    this.caption.replaceChildren();
    this.caption.appendChild(el("span", "font-display text-sm font-semibold text-ink", clip.keyword));
    this.caption.appendChild(el("span", "font-mono text-[0.6rem] uppercase tracking-wide text-ink/80", `preview · ${clip.photographer} on Pexels`));
    this.caption.style.opacity = "1";
  }

  private show(clip: MontageClip): void {
    const next = this.layers[1 - this.front];
    next.src = clip.videoUrl;
    next.poster = clip.thumbnailUrl;
    // A blocked or failed autoplay leaves the poster frame visible, which is
    // still the right image for the keyword — so the fade happens either way.
    void next.play().catch(() => undefined);
    next.style.opacity = "1";
    this.layers[this.front].style.opacity = "0";
    this.front = 1 - this.front;
    this.setCaption(clip);

    window.setTimeout(() => {
      const idle = this.layers[1 - this.front];
      if (idle.style.opacity === "0") idle.pause();
    }, CROSSFADE_MS);
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.clips.length === 0) return;
      this.index = (this.index + 1) % this.clips.length;
      this.show(this.clips[this.index]);
      this.schedule();
    }, CLIP_HOLD_MS);
  }

  destroy(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    for (const layer of this.layers) {
      layer.pause();
      layer.removeAttribute("src");
      layer.load();
    }
  }
}

interface VideoCard {
  root: HTMLElement;
  montage: MontagePlayer;
  hook: HTMLElement;
  meta: HTMLElement;
  actions: HTMLElement;
  placeholder: HTMLElement;
}

const cards = new Map<string, VideoCard>();
let activeTraceId: string | null = null;
let montageConfigured = true;
let montageNote: string | null = null;

function buildCard(): VideoCard {
  const root = el("article", "glass-card gradient-accent-border flex flex-col overflow-hidden");

  const stage = el("div", "relative aspect-[4/5] w-full overflow-hidden bg-slate/70");
  const placeholder = el("p", "absolute inset-0 flex items-center justify-center px-6 text-center font-body text-xs text-mercury/50", "Waiting for the script…");
  stage.appendChild(placeholder);
  const montage = new MontagePlayer(stage);
  root.appendChild(stage);

  const body = el("div", "flex flex-1 flex-col gap-3 p-4");
  const hook = el("p", "font-display text-sm font-semibold leading-snug text-mercury");
  const meta = el("div", "flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[0.7rem] text-mercury/60");
  const actions = el("div", "mt-auto flex flex-wrap items-center gap-2");
  body.appendChild(hook);
  body.appendChild(meta);
  body.appendChild(actions);
  root.appendChild(body);

  return { root, montage, hook, meta, actions, placeholder };
}

function renderReviewActions(card: VideoCard, video: RunVideo, onChanged: () => void): void {
  card.actions.replaceChildren();
  if (video.exportId === null) {
    const state = video.renderId === null ? "rendering" : `render ${video.renderStatus ?? "pending"}`;
    card.actions.appendChild(el("span", "font-mono text-[0.7rem] uppercase tracking-wide text-mercury/45", state));
    return;
  }

  const exportId = video.exportId;

  const download = document.createElement("a");
  download.href = downloadExportUrl(exportId);
  download.className = "rounded-full border border-sodium/40 px-3.5 py-1.5 font-body text-xs text-sodium transition-colors hover:bg-sodium/10";
  download.textContent = "Download";
  card.actions.appendChild(download);

  // Same two transitions the review queue offers, driven through the same
  // endpoints (src/console/scripts/review-queue.ts) — one-shot POSTs, never
  // auto-retried, because a retried discard is a destructive double-fire.
  if (video.exportStatus === "ready_for_review" || video.exportStatus === "downloaded") {
    const reviewed = el("button", "rounded-full border border-oxide/40 px-3.5 py-1.5 font-body text-xs text-oxide transition-colors hover:bg-oxide/10", "Mark reviewed");
    reviewed.type = "button";
    reviewed.addEventListener("click", () => {
      void (async () => {
        reviewed.disabled = true;
        const result = await markExportReviewed(exportId);
        if (result.ok) onChanged();
        else reviewed.disabled = false;
      })();
    });

    const discard = el("button", "rounded-full border border-rose/40 px-3.5 py-1.5 font-body text-xs text-rose transition-colors hover:bg-rose/10", "Discard");
    discard.type = "button";
    discard.addEventListener("click", () => {
      void (async () => {
        discard.disabled = true;
        const result = await discardExport(exportId);
        if (result.ok) onChanged();
        else discard.disabled = false;
      })();
    });

    card.actions.appendChild(reviewed);
    card.actions.appendChild(discard);
  } else if (video.exportStatus !== null) {
    card.actions.appendChild(el("span", "font-mono text-[0.7rem] uppercase tracking-wide text-mercury/45", video.exportStatus.replace(/_/g, " ")));
  }
}

function renderVideos(progress: RunProgress, onChanged: () => void): void {
  const host = document.getElementById("run-videos");
  const empty = document.getElementById("run-videos-empty");
  if (!host || !empty) return;

  empty.hidden = progress.videos.length > 0;
  if (progress.videos.length === 0) {
    empty.textContent =
      progress.status === "not_triggered"
        ? "No videos: this run was recorded but never started, so no stage has run."
        : "No script yet. The first video appears here the moment SCRIPT writes one.";
  }

  const seen = new Set<string>();
  for (const video of progress.videos) {
    seen.add(video.scriptId);
    let card = cards.get(video.scriptId);
    if (!card) {
      card = buildCard();
      cards.set(video.scriptId, card);
      host.appendChild(card.root);
    }

    card.hook.textContent = video.suggestedTitle ?? video.hook;
    card.meta.replaceChildren();
    const metaParts = [
      `${video.wordCount} words`,
      video.ttsVoice,
      video.durationS !== null ? formatDuration(video.durationS) : null,
      video.sizeBytes !== null ? formatBytes(video.sizeBytes) : null,
      formatRelativeTime(video.createdAt),
    ].filter((part): part is string => part !== null && part !== "");
    for (const part of metaParts) card.meta.appendChild(el("span", undefined, part));

    if (video.keywords.length > 0) {
      card.placeholder.textContent = montageConfigured ? "Finding preview clips…" : (montageNote ?? "Preview montage unavailable.");
    }

    renderReviewActions(card, video, onChanged);
  }

  for (const [scriptId, card] of cards) {
    if (seen.has(scriptId)) continue;
    card.montage.destroy();
    card.root.remove();
    cards.delete(scriptId);
  }
}

function renderStages(progress: RunProgress): void {
  const host = document.getElementById("run-stages");
  if (!host) return;
  host.replaceChildren();

  for (const stage of progress.stages) {
    const item = el("li", "flex items-center gap-2");
    item.appendChild(el("span", `h-2 w-2 shrink-0 rounded-full ${STAGE_DOT[stage.status] ?? "bg-mercury/30"}`));
    item.appendChild(el("span", "font-body text-xs text-mercury/70", STAGE_LABEL[stage.stage] ?? stage.stage));
    if (stage.errorClass !== null) {
      item.appendChild(el("span", "font-mono text-[0.65rem] text-rose", stage.errorClass));
    }
    host.appendChild(item);
  }

  if (progress.stages.length === 0) host.appendChild(el("li", "font-body text-xs text-mercury/50", "No stage has been recorded for this run."));
}

/**
 * This view's half of the step rail: 4 while the run works, 5 once it has
 * something to review, and nothing at all when the watched run is over and
 * empty — at which point the rail belongs to the plan form above
 * (src/console/lib/step-rail.ts explains why neither script paints it
 * directly).
 */
function renderRail(progress: RunProgress): void {
  const reviewable = progress.videos.some((video) => video.exportId !== null);
  if (progress.status === "running" || progress.status === "queued") setRunStep(4);
  else if (reviewable) setRunStep(5);
  else setRunStep(null);
}

function renderHeader(progress: RunProgress): void {
  const status = document.getElementById("run-status");
  const note = document.getElementById("run-note");
  if (status) {
    status.textContent = RUN_STATUS_TEXT[progress.status];
    status.className = `inline-flex items-center rounded-full border px-3 py-1 font-mono text-xs uppercase tracking-wide ${RUN_STATUS_PILL[progress.status]}`;
  }
  if (note) {
    const failed = progress.stages.filter((stage) => stage.errorClass !== null).map((stage) => `${STAGE_LABEL[stage.stage] ?? stage.stage}: ${stage.errorClass ?? ""}`);
    const lines = [progress.note, ...failed, montageConfigured ? null : montageNote].filter((line): line is string => line !== null && line !== "");
    note.textContent = lines.join(" · ");
    note.hidden = lines.length === 0;
  }

  const started = document.getElementById("run-started");
  if (started) started.textContent = `started ${formatRelativeTime(progress.startedAt)}`;
}

async function refreshMontage(): Promise<void> {
  if (activeTraceId === null) return;
  const result = await getRunMontage(activeTraceId);
  if (!result.ok) {
    if (redirectIfUnauthorized(result.error)) return;
    montageConfigured = false;
    montageNote = `Preview montage unavailable (${result.error.kind}).`;
    return;
  }

  montageConfigured = result.value.configured;
  montageNote = result.value.configured
    ? result.value.failures.length > 0
      ? `Pexels returned nothing for ${result.value.failures.map((failure) => failure.keyword).join(", ")}.`
      : null
    : "No PEXELS_API_KEY is set, so the preview montage is off. Add one in Keys, or set it as a Worker secret.";

  for (const video of result.value.videos) {
    const card = cards.get(video.scriptId);
    if (!card) continue;
    if (video.clips.length > 0) card.placeholder.hidden = true;
    card.montage.update(video.clips);
  }
}

/** Re-reads the watched run now, rather than at the next poll — used when something outside this view (a queued plan) changed what it should show. */
export async function refreshRunView(): Promise<void> {
  await refreshProgress();
}

async function refreshProgress(): Promise<void> {
  if (activeTraceId === null) return;
  const result = await getRunProgress(activeTraceId);
  if (!result.ok) {
    if (redirectIfUnauthorized(result.error)) return;
    const note = document.getElementById("run-note");
    if (note) {
      note.textContent = `Could not read this run (${result.error.kind}).`;
      note.hidden = false;
    }
    return;
  }

  renderHeader(result.value);
  renderRail(result.value);
  renderStages(result.value);
  renderVideos(result.value, () => void refreshProgress());
}

function setActiveRun(traceId: string): void {
  activeTraceId = traceId;
  for (const card of cards.values()) {
    card.montage.destroy();
    card.root.remove();
  }
  cards.clear();

  const url = new URL(window.location.href);
  url.searchParams.set("run", traceId);
  window.history.replaceState(null, "", url);

  void refreshProgress().then(() => refreshMontage());
}

async function loadRuns(preferred: string | null): Promise<void> {
  const picker = document.getElementById("run-picker");
  if (!(picker instanceof HTMLSelectElement)) return;

  const result = await listRuns();
  if (!result.ok) {
    if (redirectIfUnauthorized(result.error)) return;
    picker.replaceChildren(new Option(`Runs unavailable (${result.error.kind})`, ""));
    picker.disabled = true;
    return;
  }

  picker.replaceChildren();
  if (result.value.length === 0) {
    picker.replaceChildren(new Option("No runs recorded yet", ""));
    picker.disabled = true;
    const empty = document.getElementById("run-videos-empty");
    if (empty) {
      empty.hidden = false;
      empty.textContent = "No runs recorded yet. Start one, or wait for the next scheduled RENDER.";
    }
    return;
  }

  picker.disabled = false;
  for (const run of result.value) {
    const label = `${RUN_STATUS_TEXT[run.status]} · ${formatRelativeTime(run.startedAt)} · ${run.videoCount} video${run.videoCount === 1 ? "" : "s"}`;
    picker.appendChild(new Option(label, run.traceId));
  }

  const chosen = preferred !== null && result.value.some((run) => run.traceId === preferred) ? preferred : result.value[0].traceId;
  picker.value = chosen;
  setActiveRun(chosen);
}

export function initRunFlow(): void {
  const picker = document.getElementById("run-picker");
  picker?.addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    if (value !== "") setActiveRun(value);
  });

  const startButton = document.getElementById("run-start");
  startButton?.addEventListener("click", () => {
    void (async () => {
      if (!(startButton instanceof HTMLButtonElement)) return;
      startButton.disabled = true;
      const result = await dispatchRun();
      startButton.disabled = false;
      if (!result.ok) {
        if (redirectIfUnauthorized(result.error)) return;
        const note = document.getElementById("run-note");
        if (note) {
          note.textContent = `Could not start a run (${result.error.kind}).`;
          note.hidden = false;
        }
        return;
      }
      await loadRuns(result.value.runId);
    })();
  });

  void loadRuns(new URL(window.location.href).searchParams.get("run"));

  startPolling(refreshProgress, PROGRESS_POLL_MS);
  startPolling(refreshMontage, MONTAGE_POLL_MS);
}
