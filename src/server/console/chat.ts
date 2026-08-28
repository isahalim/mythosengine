import { desc, eq } from "drizzle-orm";
import type { AppDb } from "../../../db/client.ts";
import { chatMessages, chatSessions } from "../../../db/schema.ts";

export type ChatRole = "user" | "assistant" | "tool";

export interface ChatSessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export async function listChatSessions(db: AppDb): Promise<ChatSessionSummary[]> {
  return db.select().from(chatSessions).orderBy(desc(chatSessions.updatedAt)).all();
}

export async function createChatSession(db: AppDb, now: () => number = Date.now): Promise<ChatSessionSummary> {
  const id = crypto.randomUUID();
  const nowIso = new Date(now()).toISOString();
  await db.insert(chatSessions).values({ id, title: "New chat", createdAt: nowIso, updatedAt: nowIso }).run();
  return { id, title: "New chat", createdAt: nowIso, updatedAt: nowIso };
}

export type DeleteChatSessionResult = { kind: "ok" } | { kind: "not_found" };

export async function deleteChatSession(db: AppDb, id: string): Promise<DeleteChatSessionResult> {
  const existing = await db.select().from(chatSessions).where(eq(chatSessions.id, id)).get();
  if (!existing) return { kind: "not_found" };
  await db.delete(chatSessions).where(eq(chatSessions.id, id)).run();
  return { kind: "ok" };
}

export interface ChatMessageRow {
  id: string;
  role: ChatRole;
  content: string;
  toolName: string | null;
  toolArgsJson: string | null;
  toolResultJson: string | null;
  createdAt: string;
}

export async function getChatMessages(db: AppDb, sessionId: string): Promise<ChatMessageRow[]> {
  const rows = await db.select().from(chatMessages).where(eq(chatMessages.sessionId, sessionId)).orderBy(chatMessages.createdAt).all();
  return rows.map((r) => ({ ...r, role: r.role as ChatRole }));
}

const TITLE_MAX_LENGTH = 60;

/**
 * Appends one message, bumps the session's updatedAt (for the "past chats"
 * sidebar's recency sort), and — on a session's first user message —
 * derives a title from it, ChatGPT-pattern. Returns the inserted row's id,
 * which src/server/agent/loop.ts reuses as the OpenAI-wire tool_call id
 * when replaying a 'tool' row back into the model's message history.
 */
export async function appendChatMessage(
  db: AppDb,
  sessionId: string,
  role: ChatRole,
  content: string,
  extra: { toolName?: string; toolArgsJson?: string; toolResultJson?: string } = {},
  now: () => number = Date.now,
): Promise<string> {
  const id = crypto.randomUUID();
  const nowIso = new Date(now()).toISOString();

  await db
    .insert(chatMessages)
    .values({
      id,
      sessionId,
      role,
      content,
      toolName: extra.toolName ?? null,
      toolArgsJson: extra.toolArgsJson ?? null,
      toolResultJson: extra.toolResultJson ?? null,
      createdAt: nowIso,
    })
    .run();

  const session = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId)).get();
  const isFirstUserMessage = role === "user" && session?.title === "New chat";
  await db
    .update(chatSessions)
    .set({ updatedAt: nowIso, ...(isFirstUserMessage ? { title: content.slice(0, TITLE_MAX_LENGTH) } : {}) })
    .where(eq(chatSessions.id, sessionId))
    .run();

  return id;
}
