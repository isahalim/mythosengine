import { describe, expect, it } from "vitest";
import { heuristicPlan, isFilmableQuery, planShots, validateShots, VIRAL_QUERY } from "./shot-plan.ts";
import type { DiscourseBeat } from "./script-schema.ts";
import type { LlmDriver } from "../drivers/types.ts";
import { err, ok } from "../result.ts";

const beats: DiscourseBeat[] = [
  { move: "question", text: "If every choice is caused, what is a verdict measuring?" },
  { move: "pushback", text: "But a prison still changes what people do next." },
  { move: "land", text: "So punishment survives and blame does not." },
];

const input = {
  hook: "Determinism makes the courtroom a theatre.",
  beats,
  body: "Determinism makes the courtroom a theatre. If every choice is caused, what is a verdict measuring? But a prison still changes what people do next. So punishment survives and blame does not.",
  debateQuestion: "Can you punish someone you do not blame?",
  topic: "philosophy" as string | null,
};

function llmReturning(content: unknown): LlmDriver {
  return {
    complete: async () => ok({ content: JSON.stringify(content), model: "openai/gpt-oss-20b", quotaRemaining: null, quotaResetAt: null } as never),
  } as unknown as LlmDriver;
}

const failingLlm = {
  complete: async () => err({ kind: "rate_limited", message: "out of tokens", retryable: true }),
} as unknown as LlmDriver;

describe("isFilmableQuery", () => {
  it("rejects the exact queries that produced an unillustrated montage", () => {
    // Live, 2026-09-01: these ranked top and returned a crystal mobile, a
    // ferry railing and two strangers on a hill for a video about moral
    // collapse.
    for (const bad of ["maybe", "yet", "perhaps", "want", "flip", "bad", "morals"]) {
      expect(isFilmableQuery(bad), bad).toBe(false);
    }
  });

  it("accepts a phrase a camera can point at", () => {
    for (const good of ["empty courtroom gallery", "prison corridor at night", "hands sorting paperwork", "crowd crossing street"]) {
      expect(isFilmableQuery(good), good).toBe(true);
    }
  });

  it("rejects a phrase that is abstract all the way through, however long", () => {
    expect(isFilmableQuery("the meaning of freedom")).toBe(false);
    expect(isFilmableQuery("morality and justice")).toBe(false);
  });

  it("keeps a phrase where one concrete noun carries it", () => {
    // "blame" alone is unfilmable; a courtroom is not.
    expect(isFilmableQuery("blame in a courtroom")).toBe(true);
  });

  it("rejects a single word, however concrete", () => {
    // One noun retrieves the library's most generic result for that noun.
    expect(isFilmableQuery("courtroom")).toBe(false);
  });
});

describe("planShots", () => {
  it("uses the model's shots when they name pictures", async () => {
    const llm = llmReturning({
      shots: [
        { beat_index: null, intent: "The setting looks solemn.", query: "empty courtroom gallery", source: "pexels" },
        { beat_index: 0, intent: "The claim looks obvious.", query: "hands sorting paperwork", source: "pexels" },
        { beat_index: 1, intent: "The counterexample lands.", query: "prison corridor night", source: "youtube" },
      ],
    });

    const result = await planShots(llm, input, "{{script_json}} {{topic}}");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.origin).toBe("model");
    expect(result.value.shots.map((s) => s.query)).toEqual(["empty courtroom gallery", "hands sorting paperwork", "prison corridor night"]);
    expect(result.value.shots.map((s) => s.source)).toContain("youtube");
    expect(result.value.degradedReason).toBeNull();
  });

  it("drops a model shot that names no picture, and says which", async () => {
    const llm = llmReturning({
      shots: [
        { beat_index: null, intent: "a", query: "empty courtroom gallery", source: "pexels" },
        { beat_index: 0, intent: "b", query: "perhaps", source: "pexels" },
        { beat_index: 1, intent: "c", query: "prison corridor night", source: "pexels" },
      ],
    });

    const result = await planShots(llm, input, "{{script_json}} {{topic}}");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.shots.map((s) => s.query)).toEqual(["empty courtroom gallery", "prison corridor night"]);
    expect(result.value.degradedReason).toContain("perhaps");
  });

  it("falls back to the heuristic rather than costing the run its video", async () => {
    const result = await planShots(failingLlm, input, "{{script_json}} {{topic}}");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.origin).toBe("heuristic");
    expect(result.value.degradedReason).toContain("rate_limited");
  });

  it("falls back when the model returns too few usable shots to be a montage", async () => {
    const llm = llmReturning({ shots: [{ beat_index: null, intent: "a", query: "maybe", source: "pexels" }] });
    const result = await planShots(llm, input, "{{script_json}} {{topic}}");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.origin).toBe("heuristic");
  });

  it("never lets the heuristic fallback reintroduce an unfilmable query", async () => {
    // The whole point: the fallback is the code that produced the bad
    // montage, so it gets the same filmability rule. It is allowed a single
    // concrete word (a model is not), but never an abstract one — no
    // "maybe", no "perhaps", whatever the frequency count says.
    const result = await planShots(failingLlm, input, "{{script_json}} {{topic}}");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.shots.length).toBeGreaterThan(0);
    for (const shot of result.value.shots) expect(isFilmableQuery(shot.query)).toBe(true);
  });

  it("short-circuits `viral` to GTA 6 gameplay without spending a token", async () => {
    let called = false;
    const watched = {
      complete: async () => {
        called = true;
        return err({ kind: "provider_error", message: "should not be reached", retryable: false });
      },
    } as unknown as LlmDriver;

    const result = await planShots(watched, { ...input, topic: "viral" }, "{{script_json}} {{topic}}");
    expect(called).toBe(false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.origin).toBe("viral_gameplay");
    expect(result.value.shots.every((s) => s.source === "youtube")).toBe(true);
    expect(result.value.shots.every((s) => s.query === VIRAL_QUERY)).toBe(true);
    // One shot per beat plus the opening image over the hook.
    expect(result.value.shots).toHaveLength(beats.length + 1);
    expect(result.value.shots[0].beatIndex).toBeNull();
  });
});

describe("validateShots", () => {
  it("drops a duplicate query so the montage never shows the same search twice", () => {
    const { shots, rejected } = validateShots(
      {
        shots: [
          { beat_index: null, intent: "a", query: "empty courtroom gallery", source: "pexels" },
          { beat_index: 0, intent: "b", query: "Empty Courtroom Gallery", source: "pexels" },
        ],
      },
      3,
    );
    expect(shots).toHaveLength(1);
    expect(rejected[0]).toContain("duplicate");
  });

  it("drops a second opening image, which would start at the same instant as the first", () => {
    const { shots, rejected } = validateShots(
      {
        shots: [
          { beat_index: null, intent: "a", query: "empty courtroom gallery", source: "pexels" },
          { beat_index: null, intent: "b", query: "prison corridor night", source: "pexels" },
        ],
      },
      3,
    );
    expect(shots).toHaveLength(1);
    expect(rejected[0]).toContain("second opening image");
  });

  it("drops a second shot on a beat that already has one", () => {
    const { shots, rejected } = validateShots(
      {
        shots: [
          { beat_index: 1, intent: "a", query: "empty courtroom gallery", source: "pexels" },
          { beat_index: 1, intent: "b", query: "prison corridor night", source: "pexels" },
        ],
      },
      3,
    );
    expect(shots).toHaveLength(1);
    expect(rejected[0]).toContain("already has a shot");
  });

  it("drops a shot pointing at a beat the script does not have", () => {
    // Otherwise the timeline places it at an even division and the cut
    // silently stops landing on the argument.
    const { shots, rejected } = validateShots({ shots: [{ beat_index: 9, intent: "a", query: "prison corridor night", source: "pexels" }] }, 3);
    expect(shots).toEqual([]);
    expect(rejected[0]).toContain("beat 9 of 3");
  });

  it("renumbers positions contiguously after a drop", () => {
    const { shots } = validateShots(
      {
        shots: [
          { beat_index: null, intent: "a", query: "empty courtroom gallery", source: "pexels" },
          { beat_index: 0, intent: "b", query: "maybe", source: "pexels" },
          { beat_index: 1, intent: "c", query: "prison corridor night", source: "pexels" },
        ],
      },
      3,
    );
    expect(shots.map((s) => s.position)).toEqual([0, 1]);
  });
});

describe("heuristicPlan", () => {
  it("records why it was reached", () => {
    const plan = heuristicPlan(input, "PLAN timed out");
    expect(plan.origin).toBe("heuristic");
    expect(plan.degradedReason).toBe("PLAN timed out");
  });
});

describe("the fallback must never be empty, and never be nonsense", () => {
  it("never emits a bare keyword as a query", async () => {
    // Letting single words through was tried and reverted within the hour:
    // the fallback emitted "ever", "there's", "it's", "see" and "gets" —
    // function words simply absent from the denylist, because a denylist
    // cannot enumerate them.
    const result = await planShots(failingLlm, input, "{{script_json}} {{topic}}");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const shot of result.value.shots) {
      expect(shot.query.trim().split(/\s+/).length, shot.query).toBeGreaterThan(1);
    }
  });

  it("tops the montage up with neutral B-roll rather than inventing an illustration", async () => {
    const thin = {
      ...input,
      hook: "Is it?",
      beats: [
        { move: "question" as const, text: "Is it?" },
        { move: "land" as const, text: "It is." },
      ],
      body: "Is it? It is.",
    };
    const result = await planShots(failingLlm, thin, "{{script_json}} {{topic}}");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.shots.length).toBeGreaterThanOrEqual(2);
    // Marked as illustrating nothing, so the audit package cannot imply it
    // was planned.
    expect(result.value.shots.some((s) => s.intent.includes("illustrates nothing"))).toBe(true);
    expect(result.value.origin).toBe("heuristic");
  });

  it("produces at least one shot for an ordinary script", async () => {
    const result = await planShots(failingLlm, input, "{{script_json}} {{topic}}");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.shots.length).toBeGreaterThan(0);
  });

  it("gives every fallback shot its own beat, so the montage does not collapse to one clip", async () => {
    // A plan whose shots all say beatIndex null starts every one of them at
    // 0; buildMontageTimeline then drops all but the last for being
    // zero-length. A fallback that did exactly that produced a two-minute
    // video out of a single clip (2026-09-01) — a montage in the plan and
    // not one on screen.
    const result = await planShots(failingLlm, input, "{{script_json}} {{topic}}");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const beats = result.value.shots.map((s) => s.beatIndex);
    expect(new Set(beats).size).toBe(beats.length);
    expect(beats.filter((b) => b === null)).toHaveLength(1);
  });

  it("renumbers fallback positions contiguously", async () => {
    const result = await planShots(failingLlm, input, "{{script_json}} {{topic}}");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.shots.map((s) => s.position)).toEqual(result.value.shots.map((_, i) => i));
  });
});
