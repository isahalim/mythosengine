import { describe, expect, it } from "vitest";
import { groundedResearch, groundingSources, WEB_SOURCE_KIND, type GroundedModel } from "./langchain-research.ts";

/**
 * These drive `buildModel`, the injected seam, rather than a mock server.
 *
 * The other drivers in this project run against a local mock HTTP server
 * because they *are* HTTP — the contract under test is a request shape. Here
 * the request is LangChain's to make, and what this module is actually
 * responsible for is everything either side of it: reading the grounding
 * metadata, refusing a citation that is not in it, and converting a thrown
 * framework error into a typed `DriverError`. Those are the tests.
 */

const GROUNDED_METADATA = {
  groundingMetadata: {
    groundingChunks: [
      { web: { uri: "https://example.com/a", title: "The A story" } },
      { web: { uri: "https://example.com/b", title: "The B story" } },
    ],
  },
};

function reply(content: string, metadata: unknown = GROUNDED_METADATA): GroundedModel {
  return {
    async invoke() {
      return { content, response_metadata: metadata };
    },
  };
}

const GOOD_BRIEF = JSON.stringify({
  summary: "Two sides, one paper.",
  key_points: ["the paper says less than either side claims"],
  claims: [
    { claim: "the letter had 400 signatories", source_title: "whatever", source_url: "https://example.com/a" },
    { claim: "the follow-up retracted a figure", source_title: "whatever", source_url: "https://example.com/b" },
  ],
});

const INPUT = { title: "Why the AI safety debate keeps collapsing", angle: "It is about who is in the room.", mustInclude: [] };

describe("groundingSources", () => {
  it("reads the pages the provider says it consulted", () => {
    expect(groundingSources(GROUNDED_METADATA)).toEqual([
      { title: "The A story", url: "https://example.com/a" },
      { title: "The B story", url: "https://example.com/b" },
    ]);
  });

  it("returns nothing rather than inventing provenance when the metadata is absent or malformed", () => {
    expect(groundingSources(undefined)).toEqual([]);
    expect(groundingSources({})).toEqual([]);
    expect(groundingSources({ groundingMetadata: { groundingChunks: "not an array" } })).toEqual([]);
    expect(groundingSources({ groundingMetadata: { groundingChunks: [{ web: {} }, { notWeb: 1 }] } })).toEqual([]);
  });

  it("falls back to the URL as the title rather than an empty one", () => {
    expect(groundingSources({ groundingMetadata: { groundingChunks: [{ web: { uri: "https://x.test/1" } }] } })).toEqual([{ title: "https://x.test/1", url: "https://x.test/1" }]);
  });
});

describe("groundedResearch", () => {
  it("builds a brief whose citations carry a null signalId and the web source kind", async () => {
    const result = await groundedResearch("key", INPUT, { buildModel: () => reply(GOOD_BRIEF) });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.citations).toHaveLength(2);
    expect(result.value.citations[0].signalId).toBeNull();
    expect(result.value.citations[0].sourceKind).toBe(WEB_SOURCE_KIND);
    expect(result.value.citations[0].url).toBe("https://example.com/a");
    // Nothing is trimmed on this path — the provider holds the pages.
    expect(result.value.toolResultsDropped).toBe(0);
  });

  it("drops a claim whose URL the search never returned", async () => {
    const invented = JSON.stringify({
      summary: "s",
      key_points: ["k"],
      claims: [
        { claim: "real", source_title: "t", source_url: "https://example.com/a" },
        { claim: "remembered", source_title: "t", source_url: "https://example.com/never-fetched" },
      ],
    });

    const result = await groundedResearch("key", INPUT, { buildModel: () => reply(invented) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The trust boundary: a model may only cite what search actually
    // returned, exactly as the corpus path may only cite what retrieval did.
    expect(result.value.citations.map((c) => c.url)).toEqual(["https://example.com/a"]);
  });

  it("fails rather than returning an uncited brief when nothing is traceable", async () => {
    const allInvented = JSON.stringify({ summary: "s", key_points: ["k"], claims: [{ claim: "c", source_title: "t", source_url: "https://elsewhere.test/1" }] });

    const result = await groundedResearch("key", INPUT, { buildModel: () => reply(allInvented) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid_response");
    expect(result.error.message).toContain("none traceable");
  });

  it("reads JSON out of a reply that also carries prose or a fence", async () => {
    const result = await groundedResearch("key", INPUT, { buildModel: () => reply("Here is the brief:\n```json\n" + GOOD_BRIEF + "\n```\n") });
    expect(result.ok).toBe(true);
  });

  it("handles LangChain's array content shape as well as a plain string", async () => {
    const model: GroundedModel = {
      async invoke() {
        return { content: [{ type: "text", text: GOOD_BRIEF }], response_metadata: GROUNDED_METADATA };
      },
    };
    const result = await groundedResearch("key", INPUT, { buildModel: () => model });
    expect(result.ok).toBe(true);
  });

  it("reports a missing key as a typed error rather than throwing", async () => {
    const result = await groundedResearch(undefined, INPUT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("not_implemented");
    expect(result.error.message).toContain("GEMINI_API_KEY");
  });

  it("converts a thrown framework error into a DriverError, classified", async () => {
    const cases: [string, string][] = [
      ["The operation was aborted due to timeout", "timeout"],
      ["429 Too Many Requests", "rate_limited"],
      ["500 Internal", "provider_error"],
    ];

    for (const [message, kind] of cases) {
      const model: GroundedModel = {
        invoke() {
          return Promise.reject(new Error(message));
        },
      };
      const result = await groundedResearch("key", INPUT, { buildModel: () => model });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.kind).toBe(kind);
    }
  });

  it("passes an AbortSignal on every call, so a hung provider cannot hold the stage open", async () => {
    let seen: AbortSignal | null = null;
    const model: GroundedModel = {
      async invoke(_messages, config) {
        seen = config.signal;
        return { content: GOOD_BRIEF, response_metadata: GROUNDED_METADATA };
      },
    };
    await groundedResearch("key", INPUT, { buildModel: () => model, timeoutMs: 1_000 });
    expect(seen).toBeInstanceOf(AbortSignal);
  });

  it("rejects a reply that is not a brief at all", async () => {
    const result = await groundedResearch("key", INPUT, { buildModel: () => reply("no json here") });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("no JSON object");
  });
});
