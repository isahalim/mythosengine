import { z } from "zod";
import type { DriverError, LlmDriver } from "../drivers/types.ts";
import { TOPICS, type Topic } from "../../server/console/ideas.ts";
import { requestValidatedJson } from "./request-json.ts";
import { GROQ_REASONING_MODEL } from "../../config/models.ts";

/**
 * DIGEST — stage 0 of the chat route (operator direction, 2026-09-04).
 *
 * The operator types a sentence; this turns it into the facts the rest of the
 * pipeline needs and cannot infer: **which topic it belongs to**, what to
 * call it, what argument was asked for, and any voice or language the
 * operator named. It does not decide *whether* to build it — that is not a
 * judgement this stage is allowed to make any more (see below).
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
 *
 * *There is no vagueness branch any more* (operator direction, 2026-09-05:
 * "get rid of the default fallback for prompt requests that are very vague
 * to just follow the other route of picking the topic most similar and
 * choosing the ranked 1st idea"). DIGEST used to also decide *whether* the
 * operator had named a real video, and a prompt it called `topic_only` was
 * handed to `rankIdeas` and became whatever story the corpus liked best for
 * that topic. That is how "make a video on the lindsay clancy trial" came
 * back as a politics story from the ranked list: the prompt names a subject
 * the model had no angle for, the empty angle forced the bare-topic branch,
 * and the operator's actual request was discarded by a classification they
 * never saw. Every brief is now built as itself — a vague one simply gives
 * grounded RESEARCH less to go on, which is the honest outcome and the one
 * the operator asked for.
 */

export interface BriefDigest {
  /** Which of the seven topics this belongs to. Always set — it drives PLAN, SOURCE's download cap and EXPORT's hashtags. */
  topic: Topic;
  /** A headline for the synthetic signal this brief becomes. Always used: there is no branch where another source of ideas supplies one. */
  title: string;
  /** The specific argument the operator wants made. Empty when they did not give one — steering for RESEARCH, never a reason to build something else. */
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
  topic: z.enum(TOPICS),
  title: z.string().min(1).max(160),
  angle: z.string().max(600),
  must_include: z.array(z.string().max(160)).max(8),
  voice: z.string().max(60).nullable(),
  language: z.string().max(40).nullable(),
});

/**
 * Words that carry no subject on their own, so that "make a video on AI"
 * reduces to "ai".
 *
 * Deliberately short and hand-written. Its one remaining job is `guessTopic`:
 * when no model answered, the topic has to be guessed from the prompt's own
 * words, and the filler would otherwise outnumber them. It no longer decides
 * anything about how a brief is routed — nothing does.
 */
const FILLER = new Set([
  "a", "an", "the", "make", "makes", "making", "create", "do", "video", "videos", "short", "shorts", "clip",
  "about", "on", "of", "for", "me", "please", "can", "you", "i", "want", "would", "like", "to", "some",
  "something", "one", "and", "or", "with", "regarding", "concerning", "topic", "idea", "new",
]);

/** The content words of a prompt — lowercased, punctuation-stripped, filler removed. */
export function contentWords(prompt: string): string[] {
  return prompt
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((word) => word.length > 1 && !FILLER.has(word));
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
 * The operator's own words, taken literally: their prompt is the title, the
 * topic is guessed from its content words, and there is no angle because
 * nothing read one. That is a thinner brief than a classified one and
 * RESEARCH has less to search with — but it is *their* brief. Until
 * 2026-09-05 this returned `topic_only` and the run went and built the
 * corpus's best story for the guessed topic instead, which meant a dead
 * classifier silently replaced the operator's request with someone else's.
 * A degrade may cost quality; it may not change the subject.
 */
export function heuristicDigest(prompt: string): BriefDigest {
  return {
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
    "Read it and describe it. Reply with JSON and nothing else.",
    "",
    "Fields:",
    `- "topic": exactly one of ${TOPICS.join(", ")}. Always required — pick the closest.`,
    '- "title": a single headline-shaped sentence naming the video this request asks for.',
    '  If they named only a subject, restate the subject as a headline. Do not substitute a different story.',
    '- "angle": the specific argument the operator wants made, in one or two sentences. Empty string if they gave none.',
    '- "must_include": anything they explicitly insisted on. Empty array if nothing.',
    '- "voice": a narrator voice they named, or null. Do not invent one.',
    '- "language": a language they asked for, or null. Do not invent one; null means English.',
    "",
    "Judge only what is in front of you. Do not research, do not embellish, and do not",
    "turn a subject into an angle the operator did not give you — an empty angle is honest",
    "and the research stage that runs after you is the thing that goes and finds one.",
    "This request WILL be built exactly as you describe it, so a title about something",
    "else is not a safer answer than a vague one; it is the only wrong answer here.",
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
 * Reads one brief. **Never fails**, and the return type says so: there is no
 * `Result` here, because a failure is not an outcome the caller has to
 * handle — it is a degraded `DigestOutcome` carrying `heuristicDigest` and
 * the reason, and the run continues on it.
 *
 * Note what is *not* here any more: no branch, no override, no floor under
 * the model's own judgement of how specific the prompt was. Every answer
 * this returns describes the brief the operator typed, and the pipeline
 * builds that brief. A degraded answer is a thinner description of the same
 * request, never a different request.
 */
export async function digestBrief(llm: LlmDriver, prompt: string, options: DigestOptions = {}): Promise<DigestOutcome> {
  const { attachmentText = "", model = GROQ_REASONING_MODEL } = options;

  const response = await requestValidatedJson(llm, model, buildPrompt(prompt, attachmentText), DigestResponseSchema);
  if (!response.ok) {
    const error: DriverError = response.error;
    return {
      digest: heuristicDigest(prompt),
      model: null,
      degradedReason: `DIGEST could not read this brief (${error.kind}: ${error.message}) — the run continued on the operator's own words, with the topic guessed from them`,
    };
  }

  const raw = response.value;
  // A title the model left empty of everything but whitespace would mint a
  // nameless signal, so the prompt itself stands in. The schema already
  // refuses an empty string; this covers " ".
  const title = raw.title.trim();

  return {
    digest: {
      topic: raw.topic,
      title: title.length > 0 ? title : prompt.trim().slice(0, 160),
      angle: raw.angle.trim(),
      mustInclude: raw.must_include.map((item) => item.trim()).filter((item) => item.length > 0),
      voice: raw.voice?.trim() || null,
      language: raw.language?.trim() || null,
    },
    model,
    degradedReason: null,
  };
}
