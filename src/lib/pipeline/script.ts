import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execAtomic, type RawSqlClient } from "../../../db/client.ts";
import type { signals } from "../../../db/schema.ts";
import { ok, type Result } from "../result.ts";
import type { DriverError, LlmDriver } from "../drivers/types.ts";
import { assertSignalTransition } from "../state.ts";
import { DiscourseScriptResponseSchema, type DiscourseBeat, type DiscourseScriptResponse } from "./script-schema.ts";
import { requestValidatedJson } from "./request-json.ts";
import { describeAdvisories, discourseWordCount, estimatedReadSeconds, flattenBeats, reviewScript, type ScriptAdvisory } from "./discourse.ts";
import { describePerformance, rollPerformance, type PerformancePlan } from "./performance.ts";
import { malformedTags, stripTags } from "./delivery-tags.ts";
import type { ResearchBrief } from "../rag/research.ts";
import { GROQ_REASONING_MODEL } from "../../config/models.ts";

/**
 * The default when RENDER does not name one, which is every model call this
 * stage makes if a direct caller or a test leaves it out. SCRIPT spent a few
 * hours on Gemini on 2026-09-01 and is back here — src/config/models.ts has
 * the whole story.
 */
const SCRIPT_MODEL = GROQ_REASONING_MODEL;
const DISCOURSE_PROMPT_PATH = join(process.cwd(), "prompts", "script.v4.md");

export interface GeneratedScript {
  id: string;
  hook: string;
  body: string;
  debateQuestion: string;
  wordCount: number;
  /**
   * The discourse beats. Everything downstream that only needs the words
   * reads `body`, which carries the spoken narration; `beats` is for the
   * stages that vary on `move` — caption emphasis and where the footage
   * cuts.
   */
  beats: DiscourseBeat[];
  targetDurationS: number;
  /** The performance this script was written to — recorded in the audit package. */
  performance: PerformancePlan;
  /**
   * The script as written, delivery tags intact — the Gemini TTS input, and
   * the *only* field on this object that carries them.
   *
   * Everything else here is stripped, which is the safe default and is
   * deliberately the way round it is: a consumer that forgets to strip gets
   * clean text, and only the one consumer that actually performs the tags
   * has to ask for them by name. The alternative — raw by default — put
   * `[excitedly]` one careless field away from the YouTube title
   * (`upload-metadata.ts` builds it from `hook`) and from the export
   * package's script.
   */
  narration: { hook: string; beats: DiscourseBeat[]; openQuestion: string };
  /**
   * Advisory review findings the draft was accepted with — in practice a
   * length estimate outside the ±25% band (discourse.ts).
   *
   * Empty on a clean draft. Never a reason to fail: AUDIT SUMMARY flags the
   * same miss on the operator's review surface from the same ruler, so this
   * is here for the render log, not as a second gate.
   */
  structureNotes: string[];
}

function loadDiscoursePromptTemplate(): string {
  return readFileSync(DISCOURSE_PROMPT_PATH, "utf8");
}

/**
 * The research block as the drafting prompt sees it. Deliberately plain
 * text, not JSON: the model is being asked to write from it, not to parse
 * it, and prose costs fewer tokens than a re-serialized object.
 *
 * An absent brief renders as an explicit "no research available" line
 * rather than an empty block — prompt v2 has a rule for that case, and a
 * silently blank section reads to a model like an oversight it should fill
 * in from memory, which is the exact failure this stage exists to stop.
 */
export function formatResearchBrief(brief: ResearchBrief | null): string {
  if (!brief) return "No research was available for this topic. Write from the signal alone (rule 5).";

  const points = brief.keyPoints.map((point) => `- ${point}`).join("\n");
  const sources = brief.citations.map((c) => `- ${c.claim} [${c.sourceKind}: ${c.title}]`).join("\n");
  return `${brief.summary}\n\nKey points:\n${points}\n\nWhat each source supports:\n${sources}`;
}

/** A draft and what review had to say about it. */
interface EvaluatedDraft {
  draft: DiscourseScriptResponse;
  advisories: ScriptAdvisory[];
}

/**
 * Which of two drafts to keep: the one whose estimated read time lands
 * closest to the target.
 *
 * That is the only thing the length estimate is good enough to decide — a
 * ranking between two drafts we already have, never a gate one of them can
 * fail. It used to also rank by "fatal" structural violations; there are no
 * longer any (discourse.ts).
 */
function betterDraft(a: EvaluatedDraft, b: EvaluatedDraft, targetDurationS: number): EvaluatedDraft {
  const missA = Math.abs(estimatedReadSeconds(a.draft) - targetDurationS);
  const missB = Math.abs(estimatedReadSeconds(b.draft) - targetDurationS);
  return missB < missA ? b : a;
}

/**
 * How many drafts SCRIPT may ask for.
 *
 * Two, and only when the first misses the length badly enough to be worth a
 * second — `requestValidatedJson` already spends up to two calls of its own
 * repairing malformed JSON, so a third round could cost six Groq calls for
 * one script against a 200K-tokens-per-day ceiling that two renders already
 * fill. The second draft is a nudge, not a gate: whichever of the two lands
 * closer is the one that ships, and a script that misses twice still ships.
 */
const STRUCTURE_ATTEMPTS = 2;

/**
 * SCRIPT — the narration, written in beats to a rolled performance.
 *
 * The prompt receives the signal title, the RESEARCH brief and the
 * performance plan, and nothing else — still no general "what you know about
 * X", because everything in the research block traces to a signal this
 * system ingested and cited. A null brief is a supported state: RESEARCH is
 * allowed to fail, and the day's video ships written from the title alone
 * with the audit package saying so.
 *
 * **This stage no longer has a gate.** It had one until 2026-09-03: a script
 * had to be a discourse — a `pushback` between an `attempt` and a `land` —
 * or the render was refused. That rule threw away finished renders for the
 * crime of being a different shape, and the shapes it excluded are the ones
 * `SCRIPT_FORMATS` now rolls between. What is left is a single length
 * advisory, and it is a nudge: a draft that misses gets one rewrite, and
 * whichever of the two lands closer ships regardless. The only ways this
 * function fails are the ways any driver call fails — a provider error, or
 * JSON that never validates.
 *
 * `performance` is what makes two videos on the same signal sound different:
 * the format, the tone at each phase of the arc, which non-verbal sounds are
 * in play and roughly how many. Rolled outside the model (performance.ts) and
 * handed in, so it is reproducible from the audit package and not a thing the
 * writer quietly stops varying.
 *
 * The row this writes reads like any other. `body` holds the flattened
 * narration with every delivery tag stripped — the same string Edge TTS is
 * handed and the captions are built from — so AUDIT SUMMARY's near-duplicate
 * check, the export package and the console's review queue all keep working
 * without learning what a beat or a tag is.
 */
export async function generateDiscourseScript(
  rawClient: RawSqlClient,
  signal: Pick<typeof signals.$inferSelect, "id" | "title">,
  llm: LlmDriver,
  targetDurationS: number,
  research: ResearchBrief | null = null,
  now: () => number = Date.now,
  promptTemplate: string = loadDiscoursePromptTemplate(),
  traceId: string | null = null,
  model: string = SCRIPT_MODEL,
  performance: PerformancePlan = rollPerformance(traceId ?? crypto.randomUUID()),
): Promise<Result<GeneratedScript, DriverError>> {
  const basePrompt = promptTemplate
    .replace("{{signal_title_and_summary}}", signal.title)
    .replace("{{research_brief}}", formatResearchBrief(research))
    .replace("{{target_duration_s}}", String(targetDurationS))
    .replace("{{performance}}", describePerformance(performance));

  const attemptDraft = async (systemPrompt: string): Promise<Result<EvaluatedDraft, DriverError>> => {
    const validated = await requestValidatedJson(llm, model, systemPrompt, DiscourseScriptResponseSchema);
    if (!validated.ok) return validated;
    return ok({ draft: validated.value, advisories: reviewScript(validated.value, targetDurationS) });
  };

  const first = await attemptDraft(basePrompt);
  if (!first.ok) return first;

  // `last` is what the retry is told about; `best` is what is kept. They
  // differ whenever a rewrite trades one fault for another — the live
  // 2026-09-03 run wrote a draft under the floor, then one over the ceiling,
  // and the old loop scored only the second, so the closer of the two was
  // discarded before anything looked at it.
  let last = first.value;
  let best = first.value;

  for (let retry = 1; retry < STRUCTURE_ATTEMPTS && last.advisories.length > 0; retry++) {
    const next = await attemptDraft(
      `${basePrompt}\n\n<previous_draft_was_the_wrong_length>Your last draft came back the wrong length:\n${describeAdvisories(last.advisories)}\n\nWrite it again at the right length. Keep the angle, the research grounding, the format and the delivery tags; change how much there is of it.</previous_draft_was_the_wrong_length>`,
    );
    if (!next.ok) return next;
    last = next.value;
    best = betterDraft(best, next.value, targetDurationS);
  }

  const draft = best.draft;
  // Everything worth telling the operator, in one list: the length miss if
  // there is one, and any bracketed note the writer wrote that was not usable
  // delivery direction. The second matters because a malformed tag is
  // silently dropped from the audio — the video is fine, but the performance
  // the script asked for is not the one that was spoken, and that difference
  // has to be visible somewhere.
  const structureNotes = best.advisories.map((advisory) => advisory.message);
  const badTags = [draft.hook, ...draft.beats.map((beat) => beat.text), draft.open_question].flatMap((text) => malformedTags(text));
  if (badTags.length > 0) {
    structureNotes.push(`${badTags.length} delivery tag(s) were not usable direction and were dropped from the narration: ${badTags.map((tag) => `[${tag}]`).join(", ")}`);
  }
  const body = flattenBeats(draft);
  const wc = discourseWordCount(draft);
  // Stripped for every consumer but the Gemini request. `hook` in particular
  // becomes the YouTube title.
  const cleanHook = stripTags(draft.hook);
  const cleanOpenQuestion = stripTags(draft.open_question);
  const cleanBeats = draft.beats.map((beat) => ({ ...beat, text: stripTags(beat.text) }));
  const scriptId = crypto.randomUUID();
  const nowIso = new Date(now()).toISOString();

  assertSignalTransition("scored", "scripted");

  await execAtomic(rawClient, [
    {
      sql: `INSERT INTO scripts (id, signal_id, hook, body, debate_question, word_count, status, trace_id, beats, target_duration_s, created_at) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
      // `hook`/`debate_question`/`body` land stripped, because that is what
      // the console renders and what EXPORT's listing is built from.
      // `beats` keeps the tags: it is the record of the performance that was
      // asked for, and the audit package is where a reviewer goes to see it.
      params: [scriptId, signal.id, cleanHook, body, cleanOpenQuestion, wc, traceId, JSON.stringify(draft.beats), targetDurationS, nowIso],
    },
    { sql: `UPDATE signals SET state = 'scripted' WHERE id = ?`, params: [signal.id] },
  ]);

  return ok({
    id: scriptId,
    hook: cleanHook,
    body,
    debateQuestion: cleanOpenQuestion,
    wordCount: wc,
    beats: cleanBeats,
    targetDurationS,
    performance,
    narration: { hook: draft.hook, beats: draft.beats, openQuestion: draft.open_question },
    structureNotes,
  });
}
