// Chat-agent console (Groq tool-calling over the same /console/* API
// surface every other console page uses — src/server/agent/**). Same
// vanilla-DOM pattern as review-queue.ts/dashboard.ts: appendChild, never
// `.append()` (the Cloudflare-generated-types Element collision documented
// in docs/DECISIONS.md's Phase 7 entry), and every failed call renders a
// real "unavailable" state rather than fabricated data.
import { createChatSession, deleteChatSession, getChatMessages, listChatSessions, sendChatMessage } from "../lib/api.ts";
import { formatRelativeTime } from "../lib/format.ts";
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
function errorBannerEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-console-api-error]");
}
function composerFormEl(): HTMLFormElement | null {
  return document.getElementById("chat-composer") as HTMLFormElement | null;
}

async function refreshSessionList(): Promise<void> {
  const list = sessionListEl();
  if (!list) return;

  const result = await listChatSessions();
  if (!result.ok) {
    errorBannerEl()?.classList.remove("hidden");
    list.replaceChildren(el("li", "text-sm text-mercury/50", "Unavailable."));
    return;
  }
  errorBannerEl()?.classList.add("hidden");

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

function renderThread(messages: ChatMessage[]): void {
  const thread = threadEl();
  if (!thread) return;
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
    errorBannerEl()?.classList.remove("hidden");
    renderThread([]);
    return;
  }
  errorBannerEl()?.classList.add("hidden");
  renderThread(result.value);
}

function setComposerBusy(busy: boolean): void {
  const form = composerFormEl();
  if (!form) return;
  const textarea = form.querySelector("textarea");
  const button = form.querySelector("button");
  if (textarea) textarea.disabled = busy;
  if (button) (button as HTMLButtonElement).disabled = busy;
}

export function initChat(): void {
  const newChatBtn = document.getElementById("chat-new-session");
  newChatBtn?.addEventListener("click", () => {
    void (async () => {
      const result = await createChatSession();
      if (result.ok) await openSession(result.value.id);
    })();
  });

  const form = composerFormEl();
  const textareaEl = form?.querySelector("textarea");
  textareaEl?.addEventListener("input", () => {
    textareaEl.style.height = "auto";
    textareaEl.style.height = `${textareaEl.scrollHeight}px`;
  });
  textareaEl?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form?.requestSubmit();
    }
  });

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const textarea = form.querySelector("textarea");
    const content = textarea?.value.trim();
    if (!content) return;

    void (async () => {
      let sessionId = activeSessionId;
      if (!sessionId) {
        const created = await createChatSession();
        if (!created.ok) {
          errorBannerEl()?.classList.remove("hidden");
          return;
        }
        sessionId = created.value.id;
        activeSessionId = sessionId;
      }

      setComposerBusy(true);
      if (textarea) {
        textarea.value = "";
        textarea.style.height = "auto";
      }
      const existing = await getChatMessages(sessionId);
      if (existing.ok) renderThread([...existing.value, { id: "pending", role: "user", content, toolName: null, toolArgsJson: null, toolResultJson: null, createdAt: new Date().toISOString() }]);

      const result = await sendChatMessage(sessionId, content);
      setComposerBusy(false);
      if (!result.ok) {
        errorBannerEl()?.classList.remove("hidden");
        return;
      }
      errorBannerEl()?.classList.add("hidden");
      await refreshSessionList();
      const refreshed = await getChatMessages(sessionId);
      if (refreshed.ok) renderThread(refreshed.value);
    })();
  });

  void refreshSessionList();
  renderThread([]);
}
