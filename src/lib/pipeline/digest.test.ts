import { describe, expect, it } from "vitest";
import { contentWords, digestBrief, guessTopic, heuristicDigest, isBareTopic, TOPIC_ONLY_MAX_CONTENT_WORDS } from "./digest.ts";
import type { LlmDriver, LlmRequest, LlmResponse } from "../drivers/types.ts";
import { err, ok, type Result } from "../result.ts";
import type { DriverError } from "../drivers/types.ts";

/**
 * A driver that answers with whatever JSON the test hands it, or fails.
 *
 * `requestValidatedJson` retries once on a `json_validate_failed`, so the
 * queue is drained rather than the same answer repeated — otherwise a test
 * for the repair path could not tell one attempt from two.
 */
function fakeLlm(answers: (string | DriverError)[]): { llm: LlmDriver; requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  const queue = [...answers];
  return {
    requests,
    llm: {
      async complete(req: LlmRequest): Promise<Result<LlmResponse, DriverError>> {
        requests.push(req);
        const next = queue.shift();
        if (next === undefined) throw new Error("fakeLlm ran out of answers");
        if (typeof next !== "string") return err(next);
        return ok({ content: next, finishReason: "stop", quotaRemaining: null, tokensUsed: null });
      },
    },
  };
}

const SPECIFIC = JSON.stringify({
  specificity: "specific",
  topic: "ai",
  title: "Why every AI safety debate collapses into the same two people",
  angle: "The argument is really about who gets to be in the room, not about risk.",
  must_include: ["the 2026 letter"],
  voice: null,
  language: null,
});

describe("contentWords", () => {
  it("strips the filler that makes a bare topic look like a sentence", () => {
    expect(contentWords("make a video on AI")).toEqual(["ai"]);
    expect(contentWords("Can you please create a short about crypto")).toEqual(["crypto"]);
  });

  it("keeps the words that carry an argument", () => {
    expect(contentWords("why streaming prices all moved at once last month")).toEqual(["why", "streaming", "prices", "all", "moved", "at", "once", "last", "month"]);
  });
});

describe("isBareTopic", () => {
  it("is true for the operator's own example", () => {
    expect(isBareTopic("make a video on AI")).toBe(true);
  });

  it("is false for a prompt that names an argument", () => {
    expect(isBareTopic("Why every AI safety debate collapses into the same two people arguing about the same paper")).toBe(false);
  });

  it("draws the line exactly at TOPIC_ONLY_MAX_CONTENT_WORDS", () => {
    const two = "make a video on quantum computing";
    const three = "make a video on quantum computing funding";
    expect(contentWords(two)).toHaveLength(TOPIC_ONLY_MAX_CONTENT_WORDS);
    expect(isBareTopic(two)).toBe(true);
    expect(isBareTopic(three)).toBe(false);
  });
});

describe("guessTopic", () => {
  it("finds the topic a prompt is obviously about, with no model", () => {
    expect(guessTopic("make a video on AI")).toBe("ai");
    expect(guessTopic("something about the senate vote")).toBe("politics");
    expect(guessTopic("a new climate study")).toBe("science");
  });

  it("falls through to concept rather than guessing", () => {
    expect(guessTopic("loneliness")).toBe("concept");
  });
});

describe("heuristicDigest", () => {
  it("is always topic_only — without a model there is no angle to build a signal around", () => {
    expect(heuristicDigest("Why every AI safety debate collapses").specificity).toBe("topic_only");
  });
});

describe("digestBrief", () => {
  it("takes the model's answer when the prompt is long enough to be specific", async () => {
    const { llm } = fakeLlm([SPECIFIC]);
    const outcome = await digestBrief(llm, "Why every AI safety debate collapses into the same two people arguing about the same paper");

    expect(outcome.degradedReason).toBeNull();
    expect(outcome.digest.specificity).toBe("specific");
    expect(outcome.digest.topic).toBe("ai");
    expect(outcome.digest.mustInclude).toEqual(["the 2026 letter"]);
  });

  it("overrides a model that calls a two-word prompt specific, and says why", async () => {
    const { llm } = fakeLlm([SPECIFIC]);
    const outcome = await digestBrief(llm, "make a video on AI");

    // The operator's direction: a vague prompt falls back deterministically.
    // The model's opinion loses to the word count in exactly this direction.
    expect(outcome.digest.specificity).toBe("topic_only");
    expect(outcome.degradedReason).toContain("content word");
  });

  it("treats an empty angle as vagueness however the model labelled it", async () => {
    const { llm } = fakeLlm([JSON.stringify({ specificity: "specific", topic: "tech", title: "Streaming prices", angle: "   ", must_include: [], voice: null, language: null })]);
    const outcome = await digestBrief(llm, "the thing about streaming prices moving together last quarter");

    expect(outcome.digest.specificity).toBe("topic_only");
  });

  it("never fails — a dead model degrades to the heuristic and reports it", async () => {
    const failure: DriverError = { kind: "rate_limited", message: "HTTP 429", retryable: true };
    const { llm } = fakeLlm([failure]);
    const outcome = await digestBrief(llm, "Why every AI safety debate collapses into the same two people");

    expect(outcome.model).toBeNull();
    expect(outcome.digest.specificity).toBe("topic_only");
    expect(outcome.digest.topic).toBe("ai");
    expect(outcome.degradedReason).toContain("rate_limited");
  });

  it("carries a named voice and language through, and leaves them null otherwise", async () => {
    const { llm } = fakeLlm([JSON.stringify({ ...JSON.parse(SPECIFIC), voice: "Puck", language: "Spanish" })]);
    const outcome = await digestBrief(llm, "Why every AI safety debate collapses into the same two people, in Spanish");

    expect(outcome.digest.voice).toBe("Puck");
    expect(outcome.digest.language).toBe("Spanish");
  });

  it("sends the attachment text along with the prompt", async () => {
    const { llm, requests } = fakeLlm([SPECIFIC]);
    await digestBrief(llm, "Why every AI safety debate collapses into the same two people", { attachmentText: "[notes.txt]\nthe letter was signed by 400 people" });

    expect(requests[0].messages[0].content).toContain("ATTACHED MATERIAL");
    expect(requests[0].messages[0].content).toContain("signed by 400 people");
  });
});
