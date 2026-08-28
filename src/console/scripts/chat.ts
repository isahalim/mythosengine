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
  const row = el("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = [
    "flex w-full flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left transition-colors",
    session.id === activeSessionId ? "bg-mercury/10" : "hover:bg-mercury/5",
  ].join(" ");

  const title = el("span", "truncate w-full font-body text-sm text-bone", session.title);
  const time = el("span", "font-mono text-xs text-mercury/50", formatRelativeTime(session.updatedAt));
  button.appendChild(title);
  button.appendChild(time);
  button.addEventListener("click", () => void openSession(session.id));

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "mt-1 font-mono text-xs text-rose/70 hover:text-rose";
  deleteBtn.textContent = "Delete";
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
    const li = el("li", "glass-card w-fit max-w-[85%] px-3 py-2 font-mono text-xs text-oxide");
    li.textContent = `→ ran ${message.toolName ?? "a tool"}`;
    return li;
  }

  const isUser = message.role === "user";
  const li = el(
    "li",
    `max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2 font-body text-sm ${
      isUser ? "ml-auto bg-sodium/15 text-bone" : "glass-card text-mercury"
    }`,
    message.content,
  );
  return li;
}

function renderThread(messages: ChatMessage[]): void {
  const thread = threadEl();
  if (!thread) return;
  thread.replaceChildren();
  if (messages.length === 0) {
    thread.appendChild(el("li", "text-sm text-mercury/50", "Ask it to check the pipeline status, preview a settings change, or trigger a run."));
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
      if (textarea) textarea.value = "";
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
