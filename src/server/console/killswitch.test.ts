import { describe, expect, it } from "vitest";
import { isPipelineEnabled, setPipelineEnabled } from "./killswitch.ts";

class FakeKv {
  private readonly store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

describe("killswitch", () => {
  it("defaults to enabled when never set", async () => {
    expect(await isPipelineEnabled(new FakeKv())).toBe(true);
  });

  it("reports disabled once explicitly switched off", async () => {
    const kv = new FakeKv();
    await setPipelineEnabled(kv, false);
    expect(await isPipelineEnabled(kv)).toBe(false);
  });

  it("can be switched back on", async () => {
    const kv = new FakeKv();
    await setPipelineEnabled(kv, false);
    await setPipelineEnabled(kv, true);
    expect(await isPipelineEnabled(kv)).toBe(true);
  });
});
