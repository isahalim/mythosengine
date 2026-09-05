import { z } from "zod";
import type { DriverError, LlmDriver } from "../drivers/types.ts";
import { TOPICS, type Topic } from "../../server/console/ideas.ts";
import { requestValidatedJson } from "./request-json.ts";
import { GROQ_REASONING_MODEL } from "../../config/models.ts";

/**
 * DIGEST — stage 0 of the chat route (operator direction, 2026-09-04).
 *
 * The operator types a sentence; this turns it into the two facts the rest
 * of the pipeline needs and cannot infer: **which topic it belongs to**, and
 * **whether it names an actual video or merely a subject area**.
 *
 * *Why this runs in GitHub Actions and not in the Worker.* CLAUDE.md: the
 * Worker makes no model call anywhere and holds no model credential. That
 * rule is not bent for a nicer chat latency. `POST /console/briefs` stores
 * the prompt and dispatches; everything on this page happens on the runner,
 * and the chat surface watches the run rather than waiting on a reply.
 *
 * *Why it is on the general ladder rather than on LangChain.* RESEARCH is
 * the stage the operator asked to move to LangChain, and it is the one where
 * LangChain earns its place — a grounded search loop is exactly what it is
 * for. DIGEST is a small classification with a schema, and putting it on the
 * ladder buys three things a framework call would throw away: the sticky
 * descent through Flash Lite → gpt-oss-120b → gpt-oss-20b, the render's one
 * shared rate limiter, and `lastUsed()` provenance for the audit package. A
 * stage that cannot say which model answered it is a stage this project does
 * not ship.
 *
 * *What happens when it fails.* Nothing is thrown. `digestBrief` returns a
 * degraded result carrying the heuristic's answer and a reason, and the run
 * continues on it — the same contract RESEARCH, EDIT, CRITIC and the host
 * overlay all hold. A brief must never lose its video to the stage that
 * merely classified it.
 */

/**
 * How specific the prompt was, and therefore which of the two routes through
 * the rest of the run it takes.
 *
 * - `specific` — the operator named a video. A synthetic `signals` row is
 *   minted from it and the pipeline builds *that*.
 * - `topic_only` — the operator named a subject ("make a video on AI"). The
 *   run falls back to the brainstorm ranking and takes **idea #1** for the
 *   topic, deterministically. The operator stays in the chat surface; only
 *   the source of the idea changes.
 */
type BriefSpecificity = "specific" | "topic_only";

export interface BriefDigest {
  specificity: BriefSpecificity;
  /** Which of the seven topics this belongs to. Always set — it drives PLAN, SOURCE's download cap and EXPORT's hashtags. */
  topic: Topic;
  /** A headline for the synthetic signal. Ignored on the `topic_only` branch, where the ranked idea supplies its own. */
  title: string;
  /** The specific argument the operator wants made. Empty means they did not give one — which is itself the vagueness signal. */
  angle: string;
  /** Anything the operator insisted on. Passed to RESEARCH as steering, never as a fact. */
  mustInclude: string[];
  /** A voice the operator named, or null for the default (Kore). */
  voice: string | null;
  /** A language the operator named, or null for the default (English). */
  language: string | null;
}

export interface DigestOutcome {
  digest: BriefDigest;
  /** Which model answered, for the audit package. Null when no rung did and the heuristic stood in. */
  model: string | null;
  /** Why this is not the model's answer, or null when it is. */
  degradedReason: string | null;
}

const DigestResponseSchema = z.object({
  specificity: z.enum(["specific", "topic_only"]),
  topic: z.enum(TOPICS),
  title: z.string().min(1).max(160),
  angle: z.string().max(600),
  must_include: z.array(z.string().max(160)).max(8),
  voice: z.string().max(60).nullable(),
  language: z.string().max(40).nullable(),
});

/**
 * Words that carry no subject on their own, so that "make a video on AI"
 * counts as one content word rather than six.
 *
 * Deliberately short and hand-written. This is not a linguistics exercise —
 * it exists so that the *shape* the operator described ("just the topic") is
 * detectable without a model, and it only ever has to separate a bare topic
 * from a sentence with an argument in it.
 */
const FILLER = new Set([
  "a", "an", "the", "make", "makes", "making", "create", "do", "video", "videos", "short", "shorts", "clip",
  "about", "on", "of", "for", "me", "please", "can", "you", "i", "want", "would", "like", "to", "some",
  "something", "one", "and", "or", "with", "regarding", "concerning", "topic", "idea", "new",
]);

/**
 * The floor under the model's own classification.
 *
 * At or below this many content words the prompt is treated as a bare topic
 * **whatever the model said**. "make a video on AI" is three content words
 * ("video" and "make" are filler, "ai" is not); a prompt that actually names
 * an argument does not fit in two.
 */
export const TOPIC_ONLY_MAX_CONTENT_WORDS = 2;

/** The content words of a prompt — lowercased, punctuation-stripped, filler removed. */
export function contentWords(prompt: string): string[] {
  return prompt
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((word) => word.length > 1 && !FILLER.has(word));
}

/**
 * Whether this prompt is a bare topic, decided **without a model**.
 *
 * The operator's direction was that a vague prompt falls back
 * "deterministically". The model's own `specificity` is an opinion and this
 * is the fact that overrides it in one direction: a prompt this short cannot
 * be specific, however confidently a model labels it. The reverse is not
 * enforced — a long prompt the model calls vague is believed, because length
 * is not the same as an argument.
 */
export function isBareTopic(prompt: string): boolean {
  return contentWords(prompt).length <= TOPIC_ONLY_MAX_CONTENT_WORDS;
}

/**
 * Term lists per topic, for the case where no model answered at all.
 *
 * These are `src/server/console/ideas.ts`'s `TOPIC_QUERIES` in spirit but
 * not in code: that expansion exists to make BM25 retrieve headlines, this
 * one exists to guess a bucket from one sentence, and a shared table would
 * be tuned against two different jobs and serve neither. `concept` is last
 * and is the fallthrough, exactly as it is the broadest topic on the dial.
 */
const TOPIC_HINTS: [Topic, string[]][] = [
  ["ai", ["ai", "artificial", "intelligence", "llm", "model", "chatgpt", "openai", "anthropic", "claude", "gemini", "agent", "automation"]],
  ["tech", ["tech", "technology", "software", "app", "startup", "chip", "hardware", "platform", "engineer", "code", "privacy", "security", "crypto"]],
  ["politics", ["politics", "political", "election", "government", "policy", "senate", "congress", "parliament", "president", "minister", "vote", "law", "protest"]],
  ["science", ["science", "research", "study", "climate", "space", "physics", "biology", "chemistry", "scientists", "experiment", "nasa", "quantum"]],
  ["philosophy", ["philosophy", "ethics", "ethical", "moral", "meaning", "freedom", "identity", "consciousness", "truth", "existential", "values"]],
  ["viral", ["viral", "trending", "outrage", "backlash", "drama", "meme", "celebrity", "internet", "reaction"]],
  ["concept", []],
];

/** The topic a prompt most looks like, with no model involved. The floor under a failed DIGEST. */
export function guessTopic(prompt: string): Topic {
  const words = new Set(contentWords(prompt));
  let best: Topic = "concept";
  let bestHits = 0;
  for (const [topic, hints] of TOPIC_HINTS) {
    const hits = hints.filter((hint) => words.has(hint)).length;
    if (hits > bestHits) {
      best = topic;
      bestHits = hits;
    }
  }
  return best;
}

/**
 * What DIGEST concludes when no model answered.
 *
 * Note that it is always `topic_only`. Without a model there is no angle to
 * build a synthetic signal around, and inventing one from the raw prompt
 * would put an unexamined sentence into the `signals` table and then into a
 * script. Falling back to the ranked corpus is the honest degrade: the
 * operator gets the best real story for their topic, and the audit package
 * says the classification never ran.
 */
export function heuristicDigest(prompt: string): BriefDigest {
  return {
    specificity: "topic_only",
    topic: guessTopic(prompt),
    title: prompt.trim().slice(0, 160),
    angle: "",
    mustInclude: [],
    voice: null,
    language: null,
  };
}

function buildPrompt(prompt: string, attachmentText: string): string {
  return [
    "You are the intake stage of a short-form video pipeline. The operator has typed a request.",
    "Classify it. Reply with JSON and nothing else.",
    "",
    "Fields:",
    '- "specificity": "specific" if the request names an actual video — a claim, a story, an angle, a specific thing to argue.',
    '  "topic_only" if it names nothing more than a subject area (for example "make a video on AI").',
    `- "topic": exactly one of ${TOPICS.join(", ")}. Always required, including for "topic_only".`,
    '- "title": a single headline-shaped sentence naming the video. For "topic_only", restate the subject.',
    '- "angle": the specific argument the operator wants made, in one or two sentences. Empty string if they gave none.',
    '- "must_include": anything they explicitly insisted on. Empty array if nothing.',
    '- "voice": a narrator voice they named, or null. Do not invent one.',
    '- "language": a language they asked for, or null. Do not invent one; null means English.',
    "",
    "Judge only what is in front of you. Do not research, do not embellish, and do not",
    "turn a subject into an angle the operator did not give you — an invented angle is",
    "worse than an honest \"topic_only\", because the pipeline can recover from the second.",
    "",
    "--- OPERATOR REQUEST ---",
    prompt,
    ...(attachmentText.length > 0 ? ["", "--- ATTACHED MATERIAL ---", attachmentText] : []),
  ].join("\n");
}

export interface DigestOptions {
  /** Text read off the operator's attachments (src/lib/pipeline/brief-attachments.ts). Empty when there were none. */
  attachmentText?: string;
  model?: string;
}

/**
 * Classifies one brief. **Never fails**, and the return type says so: there
 * is no `Result` here, because a failure is not an outcome the caller has to
 * handle — it is a degraded `DigestOutcome` carrying `heuristicDigest` and
 * the reason, and the run continues on it.
 *
 * The `isBareTopic` guard is applied to the model's answer as well as to the
 * fallback, which is the whole of "deterministically" in the operator's
 * direction: whatever the model decides, a prompt of two content words or
 * fewer takes the ranked-idea branch.
 */
export async function digestBrief(llm: LlmDriver, prompt: string, options: DigestOptions = {}): Promise<DigestOutcome> {
  const { attachmentText = "", model = GROQ_REASONING_MODEL } = options;

  const response = await requestValidatedJson(llm, model, buildPrompt(prompt, attachmentText), DigestResponseSchema);
  if (!response.ok) {
    const error: DriverError = response.error;
    return {
      digest: heuristicDigest(prompt),
      model: null,
      degradedReason: `DIGEST could not classify this brief (${error.kind}: ${error.message}) — it was treated as a bare topic and the run took the ranked-idea branch`,
    };
  }

  const raw = response.value;
  // The model's opinion, overridden in exactly one direction. See `isBareTopic`.
  const bare = isBareTopic(prompt);
  const specificity: BriefSpecificity = bare ? "topic_only" : raw.specificity;
  // An empty angle is the same statement as a short prompt: nothing was
  // named to argue. Believing "specific" here would mint a signal whose
  // whole content is a subject line.
  const withoutAngle = raw.angle.trim().length === 0;

  return {
    digest: {
      specificity: withoutAngle ? "topic_only" : specificity,
      topic: raw.topic,
      title: raw.title.trim(),
      angle: raw.angle.trim(),
      mustInclude: raw.must_include.map((item) => item.trim()).filter((item) => item.length > 0),
      voice: raw.voice?.trim() || null,
      language: raw.language?.trim() || null,
    },
    model,
    degradedReason:
      bare && raw.specificity === "specific"
        ? `the model called this brief specific, but it is ${contentWords(prompt).length} content word(s) long — it was treated as a bare topic and the run took the ranked-idea branch`
        : null,
  };
}
