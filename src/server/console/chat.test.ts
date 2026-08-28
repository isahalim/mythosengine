import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../../db/client.ts";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { appendChatMessage, createChatSession, deleteChatSession, getChatMessages, listChatSessions } from "./chat.ts";

describe("chat service", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
  });

  it("creates a session titled 'New chat' until the first user message arrives", async () => {
    const session = await createChatSession(ctx.db);
    expect(session.title).toBe("New chat");

    await appendChatMessage(ctx.db, session.id, "user", "make today's videos punchier");
    const [updated] = await listChatSessions(ctx.db);
    expect(updated.title).toBe("make today's videos punchier");
  });

  it("does not overwrite the title on a later user message", async () => {
    const session = await createChatSession(ctx.db);
    await appendChatMessage(ctx.db, session.id, "user", "first message");
    await appendChatMessage(ctx.db, session.id, "user", "second message");
    const [updated] = await listChatSessions(ctx.db);
    expect(updated.title).toBe("first message");
  });

  it("lists sessions newest-updated first", async () => {
    const a = await createChatSession(ctx.db, () => 1000);
    const b = await createChatSession(ctx.db, () => 2000);
    const sessions = await listChatSessions(ctx.db);
    expect(sessions.map((s) => s.id)).toEqual([b.id, a.id]);
  });

  it("returns messages in creation order, including tool call/result fields", async () => {
    const session = await createChatSession(ctx.db);
    await appendChatMessage(ctx.db, session.id, "user", "run it", {}, () => 1);
    await appendChatMessage(ctx.db, session.id, "tool", "ran dispatch_run", { toolName: "dispatch_run", toolArgsJson: "{}", toolResultJson: '{"ok":true}' }, () => 2);
    await appendChatMessage(ctx.db, session.id, "assistant", "Done — queued a run.", {}, () => 3);

    const messages = await getChatMessages(ctx.db, session.id);
    expect(messages.map((m) => m.role)).toEqual(["user", "tool", "assistant"]);
    expect(messages[1].toolName).toBe("dispatch_run");
    expect(messages[1].toolResultJson).toBe('{"ok":true}');
  });

  it("deletes a session (cascading its messages)", async () => {
    const session = await createChatSession(ctx.db);
    await appendChatMessage(ctx.db, session.id, "user", "hi");
    expect(await deleteChatSession(ctx.db, session.id)).toEqual({ kind: "ok" });
    expect(await getChatMessages(ctx.db, session.id)).toEqual([]);
    expect(await listChatSessions(ctx.db)).toEqual([]);
  });

  it("returns not_found deleting an unknown session", async () => {
    expect(await deleteChatSession(ctx.db, "nope")).toEqual({ kind: "not_found" });
  });
});
