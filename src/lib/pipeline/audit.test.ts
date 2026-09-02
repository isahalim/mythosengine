import { describe, expect, it } from "vitest";
import { computeAuditSummary, type AuditSummaryInput } from "./audit.ts";

function gameplayPart(segmentId = "seg1") {
  return {
    position: 0,
    segmentId,
    startMs: 0,
    endMs: 45_000,
    provider: null,
    providerClipId: null,
    photographer: null,
    pageUrl: null,
    searchQuery: null,
    beatIndex: null,
  };
}

function baseInput(overrides: Partial<AuditSummaryInput> = {}): AuditSummaryInput {
  return {
    script: {
      hook: "Everyone is wrong about this.",
      body: "word ".repeat(150).trim(),
      debateQuestion: "So who's actually right here?",
      wordCount: 150,
    },
    originalityScore: 0.8,
    minOriginalityScore: 0.5,
    policyFlags: [],
    footage: { segmentId: "seg1", footageSourceId: "fsrc1", sourceVideoId: "v1", clipStartS: 600, clipEndS: 665, usedCount: 0, parts: [gameplayPart()] },
    research: {
      model: "openai/gpt-oss-20b",
      summary: "What people are arguing about.",
      citations: [{ signalId: "sig9", claim: "the specific thing", title: "Source headline", url: "https://example.com/1", sourceKind: "rss" }],
      toolCallsMade: ["search_discourse", "read_source"],
    },
    targetDurationS: null,
    narration: null,
    characterAbsentReason: null,
  character: null,
  edit: null,
  stages: [],
    voiceUsedToday: false,
    recentScriptBodies: [],
    narrationDurationS: 45,
    captionEndMs: 45_000,
    durationToleranceMs: 500,
    ...overrides,
  };
}

describe("computeAuditSummary", () => {
  it("a clean render clears every check and carries no flags", () => {
    const result = computeAuditSummary(baseInput());
    expect(result.schemaValid).toBe(true);
    expect(result.clearsOriginalityFloor).toBe(true);
    expect(result.flaggedAsRepeat).toBe(false);
    expect(result.durationMatch.withinTolerance).toBe(true);
    expect(result.flags).toEqual([]);
  });

  it("carries the research provenance through to the reviewer", () => {
    const result = computeAuditSummary(baseInput());
    expect(result.ungrounded).toBe(false);
    expect(result.research?.citations[0]).toMatchObject({ signalId: "sig9", url: "https://example.com/1" });
    expect(result.research?.model).toBe("openai/gpt-oss-20b");
  });

  it("flags an ungrounded script without blocking it", () => {
    // RESEARCH is allowed to fail (ARCHITECTURE.md §5.2.5). The reviewer has
    // to be told, because "written from the title alone" changes how much
    // weight the script's specifics deserve.
    const result = computeAuditSummary(baseInput({ research: null }));
    expect(result.ungrounded).toBe(true);
    expect(result.flags).toContain("no research brief — script written from the signal title alone");
    // Still not a rejection: every independent check stands on its own.
    expect(result.schemaValid).toBe(true);
    expect(result.clearsOriginalityFloor).toBe(true);
  });

  it("flags low originality but does not change schemaValid or any other independent check — never blocking", () => {
    const result = computeAuditSummary(baseInput({ originalityScore: 0.1 }));
    expect(result.clearsOriginalityFloor).toBe(false);
    expect(result.flags.some((f) => f.includes("originality"))).toBe(true);
    // Everything else about the render is still evaluated and still exported-worthy.
    expect(result.schemaValid).toBe(true);
  });

  it("flags word count out of the 130-170 bound", () => {
    const result = computeAuditSummary(baseInput({ script: { hook: "h", body: "b", debateQuestion: "q?", wordCount: 40 } }));
    expect(result.wordCountInBounds).toBe(false);
    expect(result.schemaValid).toBe(false);
    expect(result.flags.some((f) => f.includes("word count"))).toBe(true);
  });

  it("flags a missing debate question", () => {
    const result = computeAuditSummary(baseInput({ script: { hook: "h", body: "b".repeat(10), debateQuestion: "", wordCount: 150 } }));
    expect(result.hasDebateQuestion).toBe(false);
    expect(result.flags.some((f) => f.includes("debate question"))).toBe(true);
  });

  it("echoes footage provenance from the library-only claim, and flags a recently-reused segment as a rotation-health signal", () => {
    const result = computeAuditSummary(baseInput({ footage: { segmentId: "seg1", footageSourceId: "fsrc1", sourceVideoId: "v1", clipStartS: 0, clipEndS: 20, usedCount: 4, parts: [gameplayPart()] } }));
    expect(result.footage.segmentId).toBe("seg1");
    expect(result.footageRecentlyUsed).toBe(true);
  });

  it("flags a caption track that runs past the narration audio beyond tolerance, but still returns a result (never throws/blocks)", () => {
    const result = computeAuditSummary(baseInput({ narrationDurationS: 45, captionEndMs: 50_000, durationToleranceMs: 500 }));
    expect(result.durationMatch.withinTolerance).toBe(false);
    expect(result.durationMatch.deltaMs).toBe(5000);
    expect(result.flags.some((f) => f.includes("captions end"))).toBe(true);
  });

  it("flags a script that's a near-verbatim repeat of a recent script", () => {
    const body = "This game changed everything about how people think about speedrunning strategy forever.";
    const result = computeAuditSummary(baseInput({ script: { hook: "h", body, debateQuestion: "q?", wordCount: 150 }, recentScriptBodies: [body] }));
    expect(result.flaggedAsRepeat).toBe(true);
    expect(result.scriptSimilarity?.maxSimilarity).toBe(1);
  });

  it("does not flag two genuinely different scripts as repeats", () => {
    const result = computeAuditSummary(
      baseInput({
        script: { hook: "h", body: "A totally different narrative about volcano documentaries and geology.", debateQuestion: "q?", wordCount: 150 },
        recentScriptBodies: ["An unrelated story about competitive chess openings and tournament drama."],
      }),
    );
    expect(result.flaggedAsRepeat).toBe(false);
  });

  it("carries forward every CRITIC policy flag verbatim, prefixed for the reviewer", () => {
    const result = computeAuditSummary(baseInput({ policyFlags: ["reads as a verbatim repost"] }));
    expect(result.policyFlags).toEqual(["reads as a verbatim repost"]);
    expect(result.flags.some((f) => f.includes("reads as a verbatim repost"))).toBe(true);
  });

  it("always sets the synthetic-media disclosure reminder", () => {
    expect(computeAuditSummary(baseInput()).syntheticMediaDisclosureReminder).toBe(true);
  });

  it("flags a voice reused earlier today as informational, not blocking", () => {
    const result = computeAuditSummary(baseInput({ voiceUsedToday: true }));
    expect(result.voiceUsedToday).toBe(true);
    expect(result.flags.some((f) => f.includes("voice already used"))).toBe(true);
    expect(result.schemaValid).toBe(true);
  });
});
