import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../../db/client.ts";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { signals, sources } from "../../../db/schema.ts";
import { DEFAULT_DIRECTIVE } from "./directive-schema.ts";
import { dryRunSettings, getSettings, resetToDefaults, updateSettings } from "./settings.ts";

describe("settings service", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
    await ctx.db.insert(sources).values({ id: "src1", kind: "reddit", url: "http://reddit.example" }).run();
  });

  it("has no active settings until one is activated", async () => {
    const settings = await getSettings(ctx.db);
    expect(settings).toBeNull();
  });

  it("resetToDefaults activates the documented default directive", async () => {
    const settings = await resetToDefaults(ctx.db, ctx.client);
    expect(settings.directive).toEqual(DEFAULT_DIRECTIVE);
    expect(await getSettings(ctx.db)).toEqual(settings);
  });

  it("dryRunSettings never activates or persists anything by itself", async () => {
    const candidate = { ...DEFAULT_DIRECTIVE, focusGames: ["minecraft"] };
    await dryRunSettings(ctx.db, candidate);
    expect(await getSettings(ctx.db)).toBeNull();
  });

  it("dryRunSettings sorts signals into wouldSkip/wouldPick by excluded topic", async () => {
    await ctx.db
      .insert(signals)
      .values([
        { id: "sig1", sourceId: "src1", canonicalUrl: "http://reddit.example/1", title: "The Great Minecraft Update Drama", observedAt: new Date().toISOString(), engagementScore: 1, simhash: "abc", state: "observed" },
        { id: "sig2", sourceId: "src1", canonicalUrl: "http://reddit.example/2", title: "A calm patch note thread", observedAt: new Date().toISOString(), engagementScore: 1, simhash: "def", state: "observed" },
      ])
      .run();

    const candidate = { ...DEFAULT_DIRECTIVE, excludeTopics: ["drama"] };
    const result = await dryRunSettings(ctx.db, candidate);
    expect(result.wouldSkip).toEqual([{ signalId: "sig1", title: "The Great Minecraft Update Drama", reason: 'matches excluded topic "drama"' }]);
    expect(result.wouldPick).toEqual([{ signalId: "sig2", title: "A calm patch note thread" }]);
  });

  it("updateSettings activates the given directive, superseding the previous active row", async () => {
    const first = await resetToDefaults(ctx.db, ctx.client);
    const candidate = { ...DEFAULT_DIRECTIVE, focusGames: ["gta-v"] };

    const activated = await updateSettings(ctx.db, ctx.client, candidate, "focus on gta");
    expect(activated.directive.focusGames).toEqual(["gta-v"]);
    expect(activated.version).not.toBe(first.version);

    const current = await getSettings(ctx.db);
    expect(current?.version).toBe(activated.version);
    expect(current?.directive.focusGames).toEqual(["gta-v"]);
  });
});
