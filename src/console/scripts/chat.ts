// Chat-agent console (Groq tool-calling over the same /console/* API
// surface every other console page uses — src/server/agent/**). Same
// vanilla-DOM pattern as review-queue.ts/dashboard.ts: appendChild, never
// `.append()` (the Cloudflare-generated-types Element collision documented
// in docs/DECISIONS.md's Phase 7 entry), and every failed call renders a
// real "unavailable" state rather than fabricated data.
import { createChatSession, deleteChatSession, getChatMessages, listChatSessions, sendChatMessage } from "../lib/api.ts";
import { formatRelativeTime } from "../lib/format.ts";
import { redirectIfUnauthorized } from "../lib/session-guard.ts";
import type { ChatMessage, ChatSessionSummary } from "../lib/types.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** A tiny inline "X" icon, built via SVG DOM APIs — no innerHTML, matching every other console script's discipline. */
function closeIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "13");
  svg.setAttribute("height", "13");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M6 6l12 12M18 6L6 18");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linecap", "round");
  svg.appendChild(path);
  return svg;
}

let activeSessionId: string | null = null;

function sessionListEl(): HTMLElement | null {
  return document.getElementById("chat-session-list");
}
function threadEl(): HTMLElement | null {
  return document.getElementById("chat-thread");
}
async function refreshSessionList(): Promise<void> {
  const list = sessionListEl();
  if (!list) return;

  const result = await listChatSessions();
  if (!result.ok) {
    if (redirectIfUnauthorized(result.error)) return;
    list.replaceChildren(el("li", "text-sm text-mercury/50", "Unavailable."));
    return;
  }

  list.replaceChildren();
  if (result.value.length === 0) {
    list.appendChild(el("li", "text-sm text-mercury/50", "No chats yet."));
    return;
  }
  for (const session of result.value) list.appendChild(buildSessionRow(session));
}

function buildSessionRow(session: ChatSessionSummary): HTMLLIElement {
  const row = el("li", "group relative");
  const button = document.createElement("button");
  button.type = "button";
  button.className = [
    "flex w-full flex-col items-start gap-0.5 rounded-xl px-3 py-2.5 pr-9 text-left transition-colors",
    session.id === activeSessionId ? "bg-mercury/10" : "hover:bg-mercury/5",
  ].join(" ");

  const title = el("span", "w-full truncate font-body text-sm text-bone", session.title);
  const time = el("span", "font-body text-xs text-mercury/40", formatRelativeTime(session.updatedAt));
  button.appendChild(title);
  button.appendChild(time);
  button.addEventListener("click", () => void openSession(session.id));

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.setAttribute("aria-label", "Delete chat");
  deleteBtn.className =
    "absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-mercury/0 transition-colors hover:bg-rose/10 hover:text-rose group-hover:text-mercury/40";
  deleteBtn.appendChild(closeIcon());
  deleteBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    void (async () => {
      const result = await deleteChatSession(session.id);
      if (result.ok) {
        if (activeSessionId === session.id) activeSessionId = null;
        await refreshSessionList();
        renderThread([]);
      }
    })();
  });

  row.appendChild(button);
  row.appendChild(deleteBtn);
  return row;
}

function buildMessageBubble(message: ChatMessage): HTMLLIElement {
  if (message.role === "tool") {
    const li = el("li", "mx-auto flex w-fit items-center gap-1.5 rounded-full border border-oxide/25 bg-oxide/10 px-3 py-1 font-body text-xs text-oxide");
    li.textContent = `Ran ${message.toolName ?? "a tool"}`;
    return li;
  }

  const isUser = message.role === "user";
  const li = el(
    "li",
    isUser
      ? "ml-auto max-w-[75%] whitespace-pre-wrap rounded-3xl bg-mercury/10 px-4 py-2.5 font-body text-sm text-bone"
      : "max-w-[75%] whitespace-pre-wrap font-body text-[0.95rem] leading-relaxed text-mercury",
    message.content,
  );
  return li;
}

const THINKING_ID = "chat-thinking";

/**
 * "Working…" indicator, appended to the thread for exactly as long as an
 * agent turn is in flight. An agent turn can be several Groq round trips
 * with tool calls between them (src/server/agent/loop.ts), so without this
 * a slow answer and a dropped one looked identical from the composer — the
 * failure mode that made the chat feel like it silently ignored harder
 * questions. `aria-live` so it is announced, not just seen.
 */
function buildThinkingBubble(): HTMLLIElement {
  const li = el("li", "flex items-center gap-1.5 py-1");
  li.id = THINKING_ID;
  li.setAttribute("aria-live", "polite");
  li.setAttribute("aria-label", "Assistant is thinking");
  for (let i = 0; i < 3; i++) li.appendChild(el("span", "thinking-dot h-1.5 w-1.5 rounded-full bg-mercury/70"));
  return li;
}

function showThinking(): void {
  const thread = threadEl();
  if (!thread || document.getElementById(THINKING_ID)) return;
  thread.appendChild(buildThinkingBubble());
  thread.scrollTop = thread.scrollHeight;
}

function hideThinking(): void {
  document.getElementById(THINKING_ID)?.remove();
}

/** A turn that failed says so in the thread itself — the banner alone left the operator's question sitting there with no visible outcome. */
function showTurnFailure(message: string): void {
  const thread = threadEl();
  if (!thread) return;
  thread.appendChild(el("li", "mx-auto w-fit max-w-[85%] rounded-xl border border-rose/25 bg-rose/10 px-3 py-2 text-center font-body text-xs text-rose", message));
  thread.scrollTop = thread.scrollHeight;
}

function renderThread(messages: ChatMessage[]): void {
  const thread = threadEl();
  if (!thread) return;
  // replaceChildren() drops the thinking bubble too; every caller that
  // re-renders mid-turn re-adds it via showThinking() below.
  thread.replaceChildren();
  if (messages.length === 0) {
    thread.appendChild(
      el("li", "mx-auto max-w-md py-12 text-center font-body text-sm text-mercury/50", "Ask it to check the pipeline status, preview a settings change, or trigger a run."),
    );
    return;
  }
  for (const message of messages) thread.appendChild(buildMessageBubble(message));
  thread.scrollTop = thread.scrollHeight;
}

async function openSession(sessionId: string): Promise<void> {
  activeSessionId = sessionId;
  await refreshSessionList();
  const result = await getChatMessages(sessionId);
  if (!result.ok) {
    if (redirectIfUnauthorized(result.error)) return;
    // An empty thread reads as an empty chat, not as a failed load — the
    // banner used to carry that distinction, so it has to be said here.
    renderThread([]);
    showTurnFailure(`Couldn't load this chat (${result.error.kind}). Nothing was lost — try reopening it.`);
    return;
  }
  renderThread(result.value);
}

/**
 * Sends one composer message to completion: creates a session if this is
 * the first message, optimistically renders the user's bubble, sends the
 * turn, and refreshes both the session list and thread. Framework-agnostic
 * on purpose — src/console/components/PromptInputBox.tsx (a React island,
 * the only React anywhere in this project) calls this the same way the
 * plain-DOM composer used to, via the "chat:send" bridge event wired in
 * src/pages/console/chat.astro, rather than duplicating this orchestration
 * in the island itself.
 */
export async function sendComposerMessage(content: string, onBusyChange?: (busy: boolean) => void): Promise<void> {
  const trimmed = content.trim();
  if (!trimmed) return;

  let sessionId = activeSessionId;
  if (!sessionId) {
    const created = await createChatSession();
    if (!created.ok) {
      if (redirectIfUnauthorized(created.error)) return;
      showTurnFailure(`Couldn't start a new chat (${created.error.kind}). Your message wasn't sent — try again.`);
      return;
    }
    sessionId = created.value.id;
    activeSessionId = sessionId;
  }

  onBusyChange?.(true);
  const existing = await getChatMessages(sessionId);
  if (existing.ok) {
    renderThread([...existing.value, { id: "pending", role: "user", content: trimmed, toolName: null, toolArgsJson: null, toolResultJson: null, createdAt: new Date().toISOString() }]);
  }
  showThinking();

  const result = await sendChatMessage(sessionId, trimmed);
  hideThinking();
  onBusyChange?.(false);
  if (!result.ok) {
    if (redirectIfUnauthorized(result.error)) return;
    // The turn may well have been persisted server-side before the failure
    // (the user message is written first — src/server/agent/loop.ts), so
    // re-read rather than assuming the thread is still accurate.
    const afterFailure = await getChatMessages(sessionId);
    if (afterFailure.ok) renderThread(afterFailure.value);
    showTurnFailure(`That turn didn't complete (${result.error.kind}). Nothing was lost — send it again, or check the dashboard.`);
    return;
  }
  await refreshSessionList();
  const refreshed = await getChatMessages(sessionId);
  if (refreshed.ok) renderThread(refreshed.value);
}

export function initChat(): void {
  const newChatBtn = document.getElementById("chat-new-session");
  newChatBtn?.addEventListener("click", () => {
    void (async () => {
      const result = await createChatSession();
      if (result.ok) {
        await openSession(result.value.id);
        return;
      }
      if (redirectIfUnauthorized(result.error)) return;
      showTurnFailure(`Couldn't start a new chat (${result.error.kind}). Try again.`);
    })();
  });

  void refreshSessionList();
  renderThread([]);
}
