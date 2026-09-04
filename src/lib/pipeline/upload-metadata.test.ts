import { describe, expect, it } from "vitest";
import { generateUploadMetadata, heuristicUploadMetadata, trimToSentence } from "./upload-metadata.ts";
import { GROQ_LIGHT_MODEL, GROQ_REASONING_MODEL } from "../../config/models.ts";
import type { DriverError, LlmDriver } from "../drivers/types.ts";
import { err, ok } from "../result.ts";

const SOURCE = {
  hook: "Airlines are still flying over war zones, and the reason is money.",
  body:
    "Why would airlines even think about flying over Russia right now? Maybe because the routes are the shortest and cheapest. " +
    "But war-zone airspace is not just a price tag; drones can appear anywhere. So the real issue is not cost, it is unpredictable danger. " +
    "Could airlines rely on their own radar and avoid the drones? The drones are low-flying and invisible to commercial systems.",
  debateQuestion: "Would you board a flight that saves twenty minutes by crossing a war zone?",
  topic: "politics",
};

function answering(content: string): LlmDriver {
  return { complete: () => Promise.resolve(ok({ content, finishReason: "completed", quotaRemaining: null, tokensUsed: 1 })) };
}

const failing: LlmDriver = {
  complete: () => Promise.resolve(err({ kind: "rate_limited", message: "HTTP 429 from groq", retryable: true } as DriverError)),
};

describe("trimToSentence", () => {
  it("cuts at a sentence boundary rather than mid-word", () => {
    // What shipped on every export until now: `.slice(0, 500)` ended a live
    // description on "What if they get".
    const text = "First sentence here. Second sentence runs on for a while and then keeps going past the limit.";
    expect(trimToSentence(text, 40)).toBe("First sentence here.");
  });

  it("falls back to a word boundary with an ellipsis when no sentence ends in range", () => {
    const trimmed = trimToSentence("a".repeat(10) + " " + "b".repeat(60), 30);
    expect(trimmed).toBe(`${"a".repeat(10)}…`);
  });

  it("leaves text that already fits completely alone", () => {
    expect(trimToSentence("Short enough.", 100)).toBe("Short enough.");
  });
});

describe("heuristicUploadMetadata", () => {
  it("produces a whole title, a description that ends, and real hashtags", () => {
    const metadata = heuristicUploadMetadata(SOURCE, "no model call was made");
    expect(metadata.title.length).toBeLessThanOrEqual(100);
    expect(metadata.description).toContain(SOURCE.debateQuestion);
    expect(metadata.hashtags.length).toBeGreaterThan(0);
    expect(metadata.degradedReason).toBe("no model call was made");
  });

  it("leads with the operator's topic, which is the one tag nothing has to infer", () => {
    expect(heuristicUploadMetadata(SOURCE, "x").hashtags[0]).toBe("politics");
  });

  it("emits bare words — the `#` belongs to whatever displays them", () => {
    for (const tag of heuristicUploadMetadata(SOURCE, "x").hashtags) expect(tag).not.toContain("#");
  });
});

describe("generateUploadMetadata", () => {
  it("asks the lighter model, named from config rather than inlined here", async () => {
    const asked: string[] = [];
    const llm: LlmDriver = {
      complete: (req) => {
        asked.push(req.model);
        return Promise.resolve(ok({ content: JSON.stringify({ title: "t", description: "d", hashtags: ["a"] }), finishReason: "ok", quotaRemaining: null, tokensUsed: 1 }));
      },
    };
    await generateUploadMetadata(llm, SOURCE);
    // Moved off the 120b model on 2026-09-03 (operator direction): one short
    // JSON from a script that is already written, with a heuristic fallback
    // under it, has no judgement in it a larger model resolves better.
    expect(asked).toEqual([GROQ_LIGHT_MODEL]);
    expect(asked).not.toContain(GROQ_REASONING_MODEL);
  });

  /**
   * The 2026-09-04 `json_validate_failed` (581 in / 1,024 out), pinned as a
   * floor rather than an exact number.
   *
   * `GROQ_LIGHT_MODEL` spends reasoning tokens before it emits, so a real
   * listing measured at 1,571 output tokens against a ceiling of 1,024.
   * Groq's JSON mode validates server-side, so the truncation came back as a
   * 400 rather than as short JSON, and this function's own fail-soft turned
   * that into a heuristic listing with a plausible reason — the operator
   * silently getting the mechanical title this file exists to replace.
   */
  it("asks for enough completion budget that the model's reasoning cannot truncate the JSON", async () => {
    let maxTokens = 0;
    const llm: LlmDriver = {
      complete: (req) => {
        maxTokens = req.maxTokens ?? 0;
        return Promise.resolve(ok({ content: JSON.stringify({ title: "t", description: "d", hashtags: ["a"] }), finishReason: "ok", quotaRemaining: null, tokensUsed: 1 }));
      },
    };
    await generateUploadMetadata(llm, SOURCE);
    expect(maxTokens).toBeGreaterThan(1_571);
  });

  it("takes the model's listing when it is well formed", async () => {
    const llm = answering(JSON.stringify({ title: "Airlines over war zones? Think again.", description: "A short argument.", hashtags: ["#aviation", "warZones"] }));
    const metadata = await generateUploadMetadata(llm, SOURCE);

    expect(metadata.title).toBe("Airlines over war zones? Think again.");
    // The `#` the model volunteered is stripped: it is added at display time,
    // and a stored one doubles up.
    expect(metadata.hashtags).toEqual(["aviation", "warZones"]);
    expect(metadata.degradedReason).toBeNull();
  });

  it("falls back to the script rather than failing the export when the model call fails", async () => {
    // This runs immediately before EXPORT. There is no caller for whom "no
    // metadata" beats "metadata from the script".
    const metadata = await generateUploadMetadata(failing, SOURCE);
    expect(metadata.title.length).toBeGreaterThan(0);
    expect(metadata.hashtags.length).toBeGreaterThan(0);
    expect(metadata.degradedReason).toContain("rate_limited");
  });

  it("falls back when the answer is not JSON, and says which failure it was", async () => {
    const metadata = await generateUploadMetadata(answering("Here's a title!"), SOURCE);
    expect(metadata.degradedReason).toContain("not JSON");
  });

  it("falls back when the JSON is the wrong shape", async () => {
    const metadata = await generateUploadMetadata(answering(JSON.stringify({ title: "t" })), SOURCE);
    expect(metadata.degradedReason).toContain("did not match");
  });

  it("fills empty hashtags from the script instead of shipping the field blank", async () => {
    // `suggestedTags: "[]"` is exactly what every export carried before this
    // stage existed, and it is the field stage 6's metadata sheet reads.
    const llm = answering(JSON.stringify({ title: "t", description: "d", hashtags: ["#", "!!"] }));
    const metadata = await generateUploadMetadata(llm, SOURCE);
    expect(metadata.hashtags.length).toBeGreaterThan(0);
    // Still counts as the model's listing — only the tags were repaired.
    expect(metadata.degradedReason).toBeNull();
  });

  it("drops a repeated hashtag rather than listing it twice", async () => {
    const llm = answering(JSON.stringify({ title: "t", description: "d", hashtags: ["aviation", "Aviation", "drones"] }));
    expect((await generateUploadMetadata(llm, SOURCE)).hashtags).toEqual(["aviation", "drones"]);
  });
});
