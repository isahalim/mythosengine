// Steps 1-3 of the guided run (plan v2 §7): how many videos, a topic per
// video, and one ranked idea chosen per topic.
//
// The three screens are one progressive form rather than three pages —
// the operator is sitting in front of it for the whole run, and a page load
// between "three videos" and "which three" would throw away the state they
// are building. Controls appear as the decision above them is made, which
// is the same "controls appear progressively" the workspace was designed
// for.
//
// What the form produces is a queue, not a render: POST /console/run-plan
// writes `run_picks` rows, and the next RENDER claims them in order
// (db/run-picks.ts). Nothing here can start a render — this system has no
// credential to trigger one (PROVISIONED.md) — so the UI says what will
// consume the picks instead of implying it just did.
import { cancelRunPick, getRunPlan, listIdeas, submitRunPlan } from "../lib/api.ts";
import { formatRelativeTime } from "../lib/format.ts";
import { redirectIfUnauthorized } from "../lib/session-guard.ts";
import { setWizardStep } from "../lib/step-rail.ts";
import { TOPICS, type QueuedPickView, type RankedIdea, type Topic } from "../lib/types.ts";

/** Matches MAX_VIDEOS_PER_PLAN in src/server/console/run-plan.ts — the server rejects anything larger with 422. */
const MAX_VIDEOS = 6;
/** Candidates offered per topic. Enough to choose between, few enough to read at a glance. */
const IDEAS_PER_TOPIC = 5;

interface Slot {
  topic: Topic | null;
  signalId: string | null;
  ideas: RankedIdea[];
  state: "idle" | "loading" | "ready" | "empty" | "error";
  error: string | null;
}

let slots: Slot[] = [];
/** Set by the page so the run view can refresh its own queue line after a submission. */
let onPlanChanged: () => void = () => undefined;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const TOPIC_LABEL: Record<Topic, string> = {
  viral: "Viral",
  politics: "Politics",
  tech: "Tech",
  science: "Science",
  ai: "AI",
  philosophy: "Philosophy",
  concept: "Concept",
};

function pickedElsewhere(exceptIndex: number): string[] {
  return slots.flatMap((slot, index) => (index !== exceptIndex && slot.signalId !== null ? [slot.signalId] : []));
}

async function loadIdeas(index: number): Promise<void> {
  const slot = slots[index];
  if (!slot || slot.topic === null) return;

  slot.state = "loading";
  slot.error = null;
  renderSlots();

  const result = await listIdeas(slot.topic, IDEAS_PER_TOPIC, pickedElsewhere(index));
  if (!result.ok) {
    if (redirectIfUnauthorized(result.error)) return;
    slot.state = "error";
    slot.error = `Could not rank ideas (${result.error.kind}).`;
    renderSlots();
    return;
  }

  slot.ideas = result.value;
  slot.state = result.value.length === 0 ? "empty" : "ready";
  // A pick that is no longer among the candidates (another slot took it, or
  // WATCH moved the signal on) is dropped rather than silently submitted.
  if (slot.signalId !== null && !result.value.some((idea) => idea.signalId === slot.signalId)) slot.signalId = null;
  renderSlots();
}

function buildTopicRow(index: number): HTMLElement {
  const row = el("div", "flex flex-wrap gap-1.5");
  for (const topic of TOPICS) {
    const active = slots[index].topic === topic;
    const chip = el(
      "button",
      `rounded-full border px-3 py-1 font-body text-xs transition-colors ${active ? "border-sodium/50 bg-sodium/10 text-sodium" : "border-mercury/20 text-mercury/60 hover:border-mercury/40 hover:text-mercury"}`,
      TOPIC_LABEL[topic],
    );
    chip.type = "button";
    chip.setAttribute("aria-pressed", String(active));
    chip.addEventListener("click", () => {
      if (slots[index].topic === topic) return;
      slots[index].topic = topic;
      slots[index].signalId = null;
      slots[index].ideas = [];
      void loadIdeas(index);
    });
    row.appendChild(chip);
  }
  return row;
}

function buildIdeaRow(index: number, idea: RankedIdea): HTMLElement {
  const chosen = slots[index].signalId === idea.signalId;
  const row = el(
    "button",
    `flex w-full flex-col gap-1 rounded-xl border px-3 py-2 text-left transition-colors ${chosen ? "border-sodium/50 bg-sodium/5" : "border-mercury/15 hover:border-mercury/30"}`,
  );
  row.type = "button";
  row.setAttribute("aria-pressed", String(chosen));

  row.appendChild(el("span", "font-body text-sm leading-snug text-mercury", idea.title));
  const meta = el("div", "flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[0.65rem] text-mercury/50");
  // Why this idea was offered, in the operator's terms: where it came from,
  // how loud it is, how well it matched the topic. Nothing here is a
  // judgement the console invented — see src/server/console/ideas.ts.
  meta.appendChild(el("span", undefined, idea.sourceKind));
  meta.appendChild(el("span", undefined, `engagement ${Math.round(idea.engagementScore)}`));
  meta.appendChild(el("span", undefined, `${idea.matchedTerms} topic term${idea.matchedTerms === 1 ? "" : "s"}`));
  meta.appendChild(el("span", undefined, formatRelativeTime(idea.observedAt)));
  row.appendChild(meta);

  row.addEventListener("click", () => {
    slots[index].signalId = chosen ? null : idea.signalId;
    renderSlots();
  });
  return row;
}

function buildSlot(index: number): HTMLElement {
  const slot = slots[index];
  const card = el("li", "glass-card flex flex-col gap-3 p-4");

  const head = el("div", "flex items-center justify-between gap-2");
  head.appendChild(el("span", "font-display text-sm font-semibold text-mercury", `Video ${index + 1}`));
  if (slot.topic !== null) head.appendChild(el("span", "font-mono text-[0.65rem] uppercase tracking-wide text-mercury/45", TOPIC_LABEL[slot.topic]));
  card.appendChild(head);

  card.appendChild(buildTopicRow(index));

  if (slot.topic === null) {
    card.appendChild(el("p", "font-body text-xs text-mercury/45", "Pick a topic to see ranked ideas."));
    return card;
  }

  if (slot.state === "loading") {
    card.appendChild(el("p", "font-body text-xs text-mercury/45", "Ranking ideas…"));
    return card;
  }
  if (slot.state === "error") {
    card.appendChild(el("p", "font-body text-xs text-rose", slot.error ?? "Unavailable."));
    return card;
  }
  if (slot.state === "empty") {
    card.appendChild(
      el(
        "p",
        "font-body text-xs text-mercury/45",
        "No scored signal matches this topic right now. WATCH ingests on its own schedule — try another topic, or come back after the next ingest.",
      ),
    );
    return card;
  }

  const list = el("div", "flex flex-col gap-2");
  for (const idea of slot.ideas) list.appendChild(buildIdeaRow(index, idea));
  card.appendChild(list);
  return card;
}

function renderSlots(): void {
  const host = document.getElementById("plan-slots");
  const submit = document.getElementById("plan-submit");
  if (!host) return;

  host.replaceChildren();
  for (let index = 0; index < slots.length; index++) host.appendChild(buildSlot(index));

  // The rail follows the first decision still outstanding: a count, then a
  // topic for every video, then an idea for each of those topics.
  if (slots.length === 0) setWizardStep(1);
  else if (slots.some((slot) => slot.topic === null)) setWizardStep(2);
  else setWizardStep(3);

  const complete = slots.length > 0 && slots.every((slot) => slot.topic !== null && slot.signalId !== null);
  if (submit instanceof HTMLButtonElement) {
    submit.disabled = !complete;
    submit.textContent = slots.length === 0 ? "Queue videos" : `Queue ${slots.length} video${slots.length === 1 ? "" : "s"}`;
  }
}

function setCount(requested: number): void {
  const count = Math.min(Math.max(requested, 0), MAX_VIDEOS);
  // Existing choices survive a count change — reducing then raising the
  // count must not silently discard a topic the operator already picked.
  if (count < slots.length) slots = slots.slice(0, count);
  else while (slots.length < count) slots.push({ topic: null, signalId: null, ideas: [], state: "idle", error: null });

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-video-count]")) {
    const active = Number(button.dataset.videoCount) === count;
    button.setAttribute("aria-pressed", String(active));
    button.classList.toggle("border-sodium/50", active);
    button.classList.toggle("bg-sodium/10", active);
    button.classList.toggle("text-sodium", active);
    button.classList.toggle("border-mercury/20", !active);
    button.classList.toggle("text-mercury/60", !active);
  }

  const slotsSection = document.getElementById("plan-slots-section");
  if (slotsSection) slotsSection.hidden = count === 0;
  renderSlots();
}

function renderQueue(picks: QueuedPickView[]): void {
  const host = document.getElementById("plan-queue");
  const empty = document.getElementById("plan-queue-empty");
  if (!host || !empty) return;

  host.replaceChildren();
  empty.hidden = picks.length > 0;

  for (const pick of picks) {
    const row = el("li", "flex items-center justify-between gap-3 rounded-xl border border-mercury/15 px-3 py-2");
    const left = el("div", "flex min-w-0 flex-col");
    left.appendChild(el("span", "truncate font-body text-sm text-mercury", pick.title ?? `(signal ${pick.signalId} is no longer in the database)`));
    left.appendChild(el("span", "font-mono text-[0.65rem] uppercase tracking-wide text-mercury/45", `${pick.topic} · queued ${formatRelativeTime(pick.createdAt)}`));
    row.appendChild(left);

    const cancel = el("button", "shrink-0 rounded-full border border-rose/40 px-3 py-1 font-body text-xs text-rose transition-colors hover:bg-rose/10", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      void (async () => {
        cancel.disabled = true;
        const result = await cancelRunPick(pick.id);
        if (result.ok) await refreshQueue();
        else cancel.disabled = false;
      })();
    });
    row.appendChild(cancel);

    host.appendChild(row);
  }
}

async function refreshQueue(): Promise<void> {
  const result = await getRunPlan();
  if (!result.ok) {
    if (redirectIfUnauthorized(result.error)) return;
    const empty = document.getElementById("plan-queue-empty");
    if (empty) {
      empty.hidden = false;
      empty.textContent = `Could not read the queue (${result.error.kind}).`;
    }
    return;
  }
  renderQueue(result.value);
  onPlanChanged();
}

function setStatus(message: string, tone: "ok" | "error"): void {
  const status = document.getElementById("plan-status");
  if (!status) return;
  status.textContent = message;
  status.hidden = message === "";
  status.className = `font-body text-xs leading-relaxed ${tone === "ok" ? "text-oxide" : "text-rose"}`;
}

async function submitPlan(): Promise<void> {
  const submit = document.getElementById("plan-submit");
  const picks = slots.flatMap((slot) => (slot.topic !== null && slot.signalId !== null ? [{ topic: slot.topic, signalId: slot.signalId }] : []));
  if (picks.length !== slots.length || picks.length === 0) return;

  if (submit instanceof HTMLButtonElement) submit.disabled = true;
  const result = await submitRunPlan(picks);
  if (submit instanceof HTMLButtonElement) submit.disabled = false;

  if (!result.ok) {
    if (redirectIfUnauthorized(result.error)) return;
    // The server's own reasons — a story picked up by another run between
    // ranking and submitting, most likely — are worth more than a generic
    // failure, so the error kind is shown as it came back.
    setStatus(`The plan was not queued (${result.error.kind}: ${result.error.message}).`, "error");
    return;
  }

  setStatus(
    `${result.value.queued} video${result.value.queued === 1 ? "" : "s"} queued. The next RENDER claims them in order — scheduled, or started from the run view below.`,
    "ok",
  );
  slots = [];
  setCount(0);
  await refreshQueue();
}

export function initRunPlanWizard(onChanged: () => void = () => undefined): void {
  onPlanChanged = onChanged;

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-video-count]")) {
    button.addEventListener("click", () => setCount(Number(button.dataset.videoCount)));
  }

  document.getElementById("plan-submit")?.addEventListener("click", () => void submitPlan());

  setCount(0);
  void refreshQueue();
}
