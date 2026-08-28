import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../../db/client.ts";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { AGENT_TOOLS, type ToolContext } from "./tools.ts";
import { DEFAULT_DIRECTIVE } from "../console/directive-schema.ts";

class FakeHotKv {
  private readonly strings = new Map<string, string>();
  private readonly blobs = new Map<string, ArrayBuffer>();
  get(key: string): Promise<string | null>;
  get(key: string, options: { type: "arrayBuffer" }): Promise<ArrayBuffer | null>;
  async get(key: string, options?: { type: "arrayBuffer" }): Promise<string | ArrayBuffer | null> {
    return options?.type === "arrayBuffer" ? (this.blobs.get(key) ?? null) : (this.strings.get(key) ?? null);
  }
  async put(key: string, value: string): Promise<void> {
    this.strings.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.strings.delete(key);
  }
}

const MASTER_KEY_B64 = "3q2-7_zdaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("AGENT_TOOLS", () => {
  let ctx: ToolContext;
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
    applyMigrations(db.client);
    const hotKv = new FakeHotKv();
    ctx = { db: db.db, rawClient: db.client, hotKv, vaultKv: hotKv, vaultMasterKey: MASTER_KEY_B64 };
  });

  it("never exposes key rotation or the killswitch as tools, by construction", () => {
    const names = AGENT_TOOLS.map((t) => t.definition.name);
    expect(names).not.toContain("rotate_key");
    expect(names).not.toContain("set_killswitch");
    expect(names).not.toContain("killswitch");
  });

  it("get_summary returns the real dashboard summary", async () => {
    const tool = AGENT_TOOLS.find((t) => t.definition.name === "get_summary");
    const result = await tool?.execute(ctx, {});
    expect(result?.ok).toBe(true);
    expect((result?.data as { killswitch: { enabled: boolean } }).killswitch.enabled).toBe(true);
  });

  it("propose_settings_update never activates anything", async () => {
    const propose = AGENT_TOOLS.find((t) => t.definition.name === "propose_settings_update");
    const result = await propose?.execute(ctx, { directive: { ...DEFAULT_DIRECTIVE, focusGames: ["minecraft"] } });
    expect(result?.ok).toBe(true);

    const getSettings = AGENT_TOOLS.find((t) => t.definition.name === "get_settings");
    const settingsResult = await getSettings?.execute(ctx, {});
    expect(settingsResult?.data).toEqual({ error: "not_configured" });
  });

  it("activate_settings_update actually activates the directive", async () => {
    const activate = AGENT_TOOLS.find((t) => t.definition.name === "activate_settings_update");
    const result = await activate?.execute(ctx, { directive: { ...DEFAULT_DIRECTIVE, focusGames: ["gta-v"] } });
    expect(result?.ok).toBe(true);

    const getSettings = AGENT_TOOLS.find((t) => t.definition.name === "get_settings");
    const settingsResult = await getSettings?.execute(ctx, {});
    expect((settingsResult?.data as { directive: { focusGames: string[] } }).directive.focusGames).toEqual(["gta-v"]);
  });

  it("returns ok:false rather than throwing on invalid arguments", async () => {
    const tool = AGENT_TOOLS.find((t) => t.definition.name === "get_export");
    const result = await tool?.execute(ctx, {});
    expect(result?.ok).toBe(false);
  });

  it("returns ok:false rather than throwing when a directive fails schema validation", async () => {
    const tool = AGENT_TOOLS.find((t) => t.definition.name === "propose_settings_update");
    const result = await tool?.execute(ctx, { directive: { focusGames: "not-an-array" } });
    expect(result?.ok).toBe(false);
  });
});
