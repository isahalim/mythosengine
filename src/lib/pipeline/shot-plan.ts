import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { DiscourseBeat } from "./script-schema.ts";
import type { DriverError, LlmDriver } from "../drivers/types.ts";
import { extractKeywords } from "./keywords.ts";
import { requestValidatedJson } from "./request-json.ts";
import { ok, type Result } from "../result.ts";

/**
 * PLAN (plan v2 §8 item 4, finally built) — what the audience sees while the
 * narrator argues.
 *
 * **Why this is a model call**, when `extractKeywords` is deliberately not:
 * CLAUDE.md's rule is to spend the model where there is real ambiguity and
 * nowhere else, and the first live stock montage settled which side of that
 * line this falls on. The frequency heuristic ranked "maybe", "yet" and
 * "perhaps" as the top visual keywords of a script about moral collapse,
 * because the script says them often — and Pexels answered with a crystal
 * mobile, a ferry railing, and two strangers on a hill. Three of eight shots
 * illustrated nothing. "Which phrase in this paragraph is a *picture*" is
 * not a counting problem, and pretending it was produced a video whose
 * images were unrelated to its argument.
 *
 * The heuristic stays as the fallback, because a failed PLAN must not cost
 * the run its video — the same contract ARCHITECTURE.md §5.2.5 gives
 * RESEARCH. A fallback plan is marked as one and the audit package says so.
 */

const PLAN_MODEL = "openai/gpt-oss-20b";
const PROMPT_PATH = join(process.cwd(), "prompts", "shot-plan.v1.md");

/** Bounds on a montage. Below two it is not a montage; above eight the shots are too short to read. */
const MIN_SHOTS = 2;
const MAX_SHOTS = 8;

export const ShotPlanResponseSchema = z
  .object({
    shots: z
      .array(
        z
          .object({
            beat_index: z.number().int().min(0).nullable(),
            intent: z.string().min(1).max(200),
            query: z.string().min(1).max(80),
            source: z.enum(["youtube", "pexels"]),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export interface PlannedShot {
  position: number;
  /** The beat this shot covers; null for the opening image over the hook. */
  beatIndex: number | null;
  /** One sentence for the reviewer: what this image is doing. */
  intent: string;
  /** What gets searched. */
  query: string;
  source: "youtube" | "pexels";
}

export interface ShotPlan {
  shots: PlannedShot[];
  /** How the plan was produced. `heuristic` means PLAN failed and this is the keyword fallback. */
  origin: "model" | "heuristic" | "viral_gameplay";
  /** Why the model plan was not used, when it was not. Null on the happy path. */
  degradedReason: string | null;
}

/**
 * Words that name no picture.
 *
 * Not a general stop list — `keywords.ts` has one of those and it did not
 * save us, because "morals" and "drown" are content words that still make
 * poor searches on their own. This is the narrower check the failure
 * actually calls for: a query that is a single abstract or functional word
 * is rejected outright, whatever ranked it.
 */
const UNFILMABLE = new Set([
  "maybe", "perhaps", "yet", "still", "however", "though", "although", "because", "reason", "reasons",
  "thing", "things", "way", "ways", "idea", "ideas", "point", "points", "fact", "facts", "truth",
  "morals", "morality", "ethics", "justice", "freedom", "consciousness", "meaning", "identity",
  "society", "culture", "value", "values", "belief", "beliefs", "choice", "choices", "blame",
  "good", "bad", "right", "wrong", "better", "worse", "real", "fake", "simple", "hard", "easy",
  "want", "need", "know", "think", "feel", "seem", "look", "flip", "drown",
  "everyone", "someone", "anyone", "nobody", "people", "person", "human", "humans",
]);

/**
 * Articles, prepositions and conjunctions. Stripped before a query is
 * judged, because they are neither concrete nor abstract — they are glue,
 * and counting them as content is what let "the meaning of freedom" pass a
 * check meant to reject exactly that.
 */
const GLUE = new Set(["a", "an", "the", "of", "in", "on", "at", "to", "for", "with", "and", "or", "into", "from", "over", "under", "by"]);

/**
 * Whether a query is worth sending to a stock search.
 *
 * Two rules, both learned from the montage that failed:
 *
 * 1. **At least one content word that names something filmable.** A phrase
 *    abstract all the way through is abstract however long it is — "the
 *    meaning of freedom" is four words and no picture. This rule is
 *    absolute; it is the one the stage exists for.
 * 2. **At least two content words** — but only on the model path. One noun
 *    retrieves the library's most generic result for that noun; two are
 *    what turn "prison" into "prison corridor at night", and a model that
 *    can write the second should be held to it.
 *
 * `allowSingleWord` is used by nothing that reaches a video, and is kept
 * only so the fallback can *test* whether a bare keyword is at least not
 * abstract. Letting single words through as queries was tried and reverted
 * within the hour: the fallback immediately emitted "ever", "there's",
 * "it's", "see" and "gets" — function words that are simply not in the
 * denylist, because a denylist cannot enumerate them. The lesson is that
 * the two-word rule was never a preference; it is the only cheap thing
 * standing between a keyword count and a montage of nonsense.
 */
export function isFilmableQuery(query: string, { allowSingleWord = false }: { allowSingleWord?: boolean } = {}): boolean {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter(Boolean);
  if (words.length > 8) return false;

  const content = words.filter((word) => !GLUE.has(word));
  if (content.length === 0) return false;
  if (content.length < 2 && !allowSingleWord) return false;
  return content.some((word) => !UNFILMABLE.has(word));
}

interface PlanInput {
  hook: string;
  beats: DiscourseBeat[];
  body: string;
  debateQuestion: string;
  /** The operator's topic for this video, when they queued one. Drives the viral short-circuit. */
  topic: string | null;
}

/**
 * The `viral` plan, which is not a plan at all and does not spend a token.
 *
 * Operator direction 2026-09-01: "make the viral option always result in the
 * background footage to be of a walkthrough of the game GTA 6". There is no
 * decision left for a model once the topic has decided the footage — every
 * shot is the same source, and which second of it you take is answered by
 * motion scoring and chance, not by language.
 */
export const VIRAL_QUERY = "GTA 6 walkthrough gameplay";

function viralPlan(beats: DiscourseBeat[]): ShotPlan {
  const count = Math.min(Math.max(beats.length + 1, MIN_SHOTS), MAX_SHOTS);
  return {
    shots: Array.from({ length: count }, (_, i) => ({
      position: i,
      beatIndex: i === 0 ? null : i - 1,
      intent: "GTA 6 walkthrough gameplay — a different moment of the run for each beat.",
      // The same query every time on purpose: one download, several windows
      // cut from it at random with head and tail buffers. The executor
      // recognises repeats of VIRAL_QUERY and reuses the source.
      query: VIRAL_QUERY,
      source: "youtube" as const,
    })),
    origin: "viral_gameplay",
    degradedReason: null,
  };
}

/**
 * The fallback plan: today's keyword extraction, one shot per beat, all
 * Pexels.
 *
 * Honest about what it is. These are the queries that produced "maybe" and
 * "perhaps", so the unfilmable ones are dropped here too — a montage of four
 * good shots beats one of eight where half are noise. If nothing survives,
 * the caller gets a plan of one general query built from the hook, which is
 * still better than a render with no footage.
 */
/**
 * Neutral B-roll, for when PLAN is unavailable and the script yields no
 * filmable phrase of its own.
 *
 * This is the honest shape of the degraded mode. The alternative — emitting
 * whatever the keyword counter ranked highest — was tried twice and
 * produced "maybe / yet / perhaps" and then "ever / there's / it's / gets".
 * Both look like an illustrated video and are not one, and a reviewer
 * cannot tell the difference from a thumbnail.
 *
 * These make no claim to illustrate any particular argument. They are
 * legible, coherent, and obviously generic, and the plan is marked
 * `origin: "heuristic"` so the audit package says the video was not
 * planned. That is a much smaller lie than a chessboard standing in for
 * "perhaps".
 */
const NEUTRAL_BROLL = [
  "city street crowd walking",
  "hands typing on laptop",
  "empty room with window light",
  "traffic at dusk timelapse",
  "person walking alone at night",
  "crowded train carriage",
  "coffee cup on a desk",
  "rain on a window pane",
];

export function heuristicPlan(input: PlanInput, reason: string): ShotPlan {
  const passages = [{ text: input.hook, beatIndex: null as number | null }, ...input.beats.map((beat, beatIndex) => ({ text: beat.text, beatIndex }))];

  const used = new Set<string>();
  const shots: PlannedShot[] = [];
  let neutralIndex = 0;

  // One shot per passage, so every shot carries the beat it covers.
  //
  // Passage order is what puts the cuts on the argument — a plan whose
  // shots all say `beatIndex: null` collapses to a single shot, because
  // `buildMontageTimeline` starts every one of them at 0 and drops all but
  // the last for being zero-length. A fallback that did exactly that
  // produced a two-minute video out of one clip (2026-09-01), which looked
  // like a montage in the plan and was not one on screen.
  for (const passage of passages.slice(0, MAX_SHOTS)) {
    // Only phrases that clear the SAME bar the model's are held to.
    const fromBeat = extractKeywords({ hook: passage.text, body: "" }, 6).find((phrase) => isFilmableQuery(phrase) && !used.has(phrase));

    // A beat too abstract to yield one gets neutral B-roll rather than a
    // bare noun. It still keeps its own beatIndex, so the cut lands where
    // the argument turns even though the image does not illustrate it.
    const query = fromBeat ?? NEUTRAL_BROLL[neutralIndex++ % NEUTRAL_BROLL.length];
    if (used.has(query)) continue;
    used.add(query);

    shots.push({
      position: shots.length,
      beatIndex: passage.beatIndex,
      intent:
        fromBeat === undefined
          ? "Neutral B-roll — PLAN did not run, so this illustrates nothing in particular."
          : "Keyword fallback — drawn from this beat's own words, because PLAN did not run.",
      query,
      source: "pexels",
    });
  }

  // A plan of zero shots reaches SOURCE, finds nothing to source, and kills
  // a render that had a finished script and a finished narration behind it.
  for (const query of NEUTRAL_BROLL) {
    if (shots.length >= MIN_SHOTS) break;
    if (used.has(query)) continue;
    used.add(query);
    shots.push({
      position: shots.length,
      beatIndex: shots.length === 0 ? null : shots.length - 1,
      intent: "Neutral B-roll — PLAN did not run, so this illustrates nothing in particular.",
      query,
      source: "pexels",
    });
  }

  return { shots, origin: "heuristic", degradedReason: reason };
}

function loadPromptTemplate(): string {
  return readFileSync(PROMPT_PATH, "utf8");
}

/**
 * Turns the model's answer into shots, dropping what it should not have
 * emitted.
 *
 * The model is asked for filmable queries and mostly gives them; this is the
 * deterministic check that the one thing this stage exists for actually
 * held. Rejected shots are dropped rather than repaired — a montage with one
 * shot fewer is fine, and a query this code invented to patch a hole would
 * be exactly the unillustrative filler the stage was built to stop.
 */
export function validateShots(raw: z.infer<typeof ShotPlanResponseSchema>, beatCount: number): { shots: PlannedShot[]; rejected: string[] } {
  const seen = new Set<string>();
  const seenBeats = new Set<number>();
  const shots: PlannedShot[] = [];
  const rejected: string[] = [];
  let seenOpening = false;

  for (const shot of raw.shots) {
    const query = shot.query.trim();
    const key = query.toLowerCase();

    if (!isFilmableQuery(query)) {
      rejected.push(`${query} (names no picture)`);
      continue;
    }
    if (seen.has(key)) {
      rejected.push(`${query} (duplicate)`);
      continue;
    }
    // A beat index past the end of the script would place a shot against a
    // beat that does not exist, and the timeline would then put it at an
    // even division instead of on the argument.
    if (shot.beat_index !== null && shot.beat_index >= beatCount) {
      rejected.push(`${query} (beat ${shot.beat_index} of ${beatCount})`);
      continue;
    }
    // Exactly one shot may be the opening image. A second `null` starts at
    // the same instant as the first, and `buildMontageTimeline` then drops
    // one of them for being zero-length — a shot silently missing from a
    // montage the plan says has it.
    if (shot.beat_index === null && seenOpening) {
      rejected.push(`${query} (a second opening image)`);
      continue;
    }
    // Likewise for two shots on the same beat: they would start together.
    if (shot.beat_index !== null && seenBeats.has(shot.beat_index)) {
      rejected.push(`${query} (beat ${shot.beat_index} already has a shot)`);
      continue;
    }
    if (shots.length >= MAX_SHOTS) {
      rejected.push(`${query} (over the ${MAX_SHOTS}-shot ceiling)`);
      continue;
    }

    seen.add(key);
    if (shot.beat_index === null) seenOpening = true;
    else seenBeats.add(shot.beat_index);
    shots.push({ position: shots.length, beatIndex: shot.beat_index, intent: shot.intent.trim(), query, source: shot.source });
  }

  return { shots, rejected };
}

/**
 * PLAN. Never returns an error: the worst outcome is the heuristic plan,
 * marked as degraded.
 */
export async function planShots(llm: LlmDriver, input: PlanInput, promptTemplate: string = loadPromptTemplate()): Promise<Result<ShotPlan, DriverError>> {
  if (input.topic === "viral") return ok(viralPlan(input.beats));

  const systemPrompt = promptTemplate
    .replace(
      "{{script_json}}",
      JSON.stringify({
        hook: input.hook,
        beats: input.beats.map((beat, i) => ({ beat_index: i, move: beat.move, text: beat.text })),
        debate_question: input.debateQuestion,
      }),
    )
    .replace("{{topic}}", input.topic ?? "unspecified");

  const validated = await requestValidatedJson(llm, PLAN_MODEL, systemPrompt, ShotPlanResponseSchema);
  if (!validated.ok) return ok(heuristicPlan(input, `${validated.error.kind}: ${validated.error.message}`));

  const { shots, rejected } = validateShots(validated.value, input.beats.length);

  // Too few usable shots means the model did not do the job, and the
  // heuristic is not obviously worse than two shots over a three-minute
  // video. Which one produced the plan is recorded either way.
  if (shots.length < MIN_SHOTS) {
    return ok(heuristicPlan(input, `PLAN returned ${shots.length} usable shot(s); rejected: ${rejected.join(", ") || "none"}`));
  }

  return ok({
    shots,
    origin: "model",
    degradedReason: rejected.length === 0 ? null : `${rejected.length} shot(s) rejected: ${rejected.join(", ")}`,
  });
}
