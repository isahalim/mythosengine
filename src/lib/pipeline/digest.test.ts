import { describe, expect, it } from "vitest";
import { contentWords, digestBrief, guessTopic, heuristicDigest } from "./digest.ts";
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
  it("keeps the operator's own words as the title rather than substituting a story", () => {
    const digest = heuristicDigest("Why every AI safety debate collapses");
    expect(digest.title).toBe("Why every AI safety debate collapses");
    expect(digest.angle).toBe("");
  });

  it("guesses the topic from the prompt, since nothing else can", () => {
    expect(heuristicDigest("make a video on AI").topic).toBe("ai");
  });
});

describe("digestBrief", () => {
  it("takes the model's answer", async () => {
    const { llm } = fakeLlm([SPECIFIC]);
    const outcome = await digestBrief(llm, "Why every AI safety debate collapses into the same two people arguing about the same paper");

    expect(outcome.degradedReason).toBeNull();
    expect(outcome.digest.topic).toBe("ai");
    expect(outcome.digest.title).toBe("Why every AI safety debate collapses into the same two people");
    expect(outcome.digest.mustInclude).toEqual(["the 2026 letter"]);
  });

  /**
   * The 2026-09-05 bug, as a test. A prompt naming one specific story came
   * back with no angle, the empty angle was read as vagueness, and the run
   * rendered the corpus's top politics story instead. There is no longer any
   * value DIGEST can return that changes WHAT gets built.
   */
  it("keeps the operator's subject when the model finds no angle in it", async () => {
    const { llm } = fakeLlm([JSON.stringify({ topic: "politics", title: "The Lindsay Clancy trial", angle: "   ", must_include: [], voice: null, language: null })]);
    const outcome = await digestBrief(llm, "make a video on the lindsay clancy trial");

    expect(outcome.digest.title).toBe("The Lindsay Clancy trial");
    expect(outcome.digest.angle).toBe("");
    expect(outcome.degradedReason).toBeNull();
  });

  it("keeps a bare subject as itself rather than reading it as a request for something else", async () => {
    const { llm } = fakeLlm([JSON.stringify({ topic: "ai", title: "AI", angle: "", must_include: [], voice: null, language: null })]);
    const outcome = await digestBrief(llm, "make a video on AI");

    expect(outcome.digest.title).toBe("AI");
    expect(outcome.digest.topic).toBe("ai");
  });

  it("never fails — a dead model degrades to the heuristic and reports it", async () => {
    const failure: DriverError = { kind: "rate_limited", message: "HTTP 429", retryable: true };
    const { llm } = fakeLlm([failure]);
    const outcome = await digestBrief(llm, "Why every AI safety debate collapses into the same two people");

    expect(outcome.model).toBeNull();
    // The operator's own words, not a substitute: a degrade may cost quality,
    // it may not change the subject.
    expect(outcome.digest.title).toBe("Why every AI safety debate collapses into the same two people");
    expect(outcome.digest.topic).toBe("ai");
    expect(outcome.degradedReason).toContain("rate_limited");
  });

  it("falls back to the prompt when the model's title is only whitespace", async () => {
    const { llm } = fakeLlm([JSON.stringify({ topic: "tech", title: " ", angle: "", must_include: [], voice: null, language: null })]);
    const outcome = await digestBrief(llm, "the thing about streaming prices moving together last quarter");

    expect(outcome.digest.title).toBe("the thing about streaming prices moving together last quarter");
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
