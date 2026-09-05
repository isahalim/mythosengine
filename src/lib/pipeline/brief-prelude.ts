import type { AppDb, RawSqlClient } from "../../../db/client.ts";
import { queueRunPlan } from "../../../db/run-picks.ts";
import type { LlmDriver } from "../drivers/types.ts";
import type { ResearchBrief } from "../rag/research.ts";
import type { StageProvenance } from "./audit.ts";
import { createOperatorSignal } from "./brief-signal.ts";
import { digestBrief, type BriefDigest } from "./digest.ts";

/**
 * The chat route's prelude: DIGEST, the operator's signal, grounded
 * RESEARCH, and the run plan.
 *
 * Lives here rather than in `scripts/pipeline/chat-render.ts` so it can be
 * tested against a real database without running a pipeline — which matters
 * more than it looks. This is glue, and glue is where the mistakes are: the
 * first version of that script imported `renderOneVideo` from `render.ts` and
 * thereby started a *second, unrelated brainstorm render* alongside the chat
 * one, because `render.ts` called `main()` at module scope. That was caught by
 * hand. Everything else here is now caught by a test.
 *
 * The script keeps only what genuinely belongs to a process: reading the
 * environment, building the drivers, opening and closing the lifecycle row.
 *
 * **Nothing in this file spends a token on footage, narration or an encoder.**
 * A run that ends inside it has cost at most two model calls.
 *
 * **There is one path through it** (operator direction, 2026-09-05). Until
 * then a brief DIGEST judged vague was handed to `rankIdeas` and became the
 * corpus's top-ranked story for its topic — and because an empty `angle`
 * counted as vague, "make a video on the lindsay clancy trial" was rendered
 * as an unrelated politics story from the ranked list. The operator's words
 * are now always what gets built: a signal is minted from them and grounded
 * research goes and looks the subject up, however little it was given. A
 * vague prompt produces a thinner brief, not somebody else's.
 */

/** How the brief was researched, for the audit package's RESEARCH line. Reached through `PreparedBrief`, so it is not exported separately. */
interface ResearchProvenanceLine {
  provider: StageProvenance["provider"];
  model: string | null;
  fallbackReason: string | null;
}

export interface PreparedBrief {
  planId: string;
  signalId: string;
  digest: BriefDigest;
  /** Null when this brief was not researched here — the render then runs the corpus path against the signal just minted. */
  research: ResearchBrief | null;
  researchProvenance: ResearchProvenanceLine | null;
  /** What DIGEST could not do, or null. Reaches the render log and the `briefs` row. */
  digestDegradedReason: string | null;
}

export interface BriefPreludeDeps {
  db: AppDb;
  rawClient: RawSqlClient;
  /** The DIGEST stage's own ladder instance, over the render's shared drivers. */
  digestLlm: LlmDriver;
  /**
   * Grounded RESEARCH for this brief. Returns null on any failure — the
   * render then takes the corpus path, then `ungrounded`.
   *
   * Injected rather than called directly so this file has no opinion about
   * LangChain, and so the tests need no provider to exercise the prelude.
   */
  research: (input: { title: string; angle: string; mustInclude: string[] }) => Promise<{ brief: ResearchBrief; provenance: ResearchProvenanceLine } | null>;
  /** Text read off the operator's attachments. Empty when there were none or none could be read. */
  attachmentText?: string;
  model?: string;
  log?: (message: string) => void;
}

/**
 * Runs the prelude.
 *
 * Always returns a prepared brief. It used to be nullable, for the one case
 * where the bare-topic branch found nothing scored in the corpus for its
 * topic; with that branch gone there is no longer any way for a brief to
 * resolve to nothing, because the thing it resolves to is the operator's own
 * sentence.
 */
export async function prepareBrief(briefId: string, prompt: string, deps: BriefPreludeDeps): Promise<PreparedBrief> {
  const { db, rawClient, digestLlm, research, attachmentText = "", model, log = console.warn } = deps;

  const { digest, degradedReason } = await digestBrief(digestLlm, prompt, { attachmentText, ...(model === undefined ? {} : { model }) });
  if (degradedReason !== null) log(`DIGEST: ${degradedReason}`);
  log(`DIGEST: "${digest.title}" — topic ${digest.topic}${digest.angle.length > 0 ? `, angle: ${digest.angle}` : ", no angle given"}.`);

  /**
   * The operator's idea, minted as a real `signals` row — for every brief,
   * with no branch in front of it.
   *
   * `brief-signal.ts` inserts it directly as `scored`, so SCORE's duplicate
   * clustering never sees it: a brief about a story already in the corpus
   * must not be rejected as a duplicate of the very story the operator is
   * trying to talk about.
   */
  const signalId = await createOperatorSignal(db, { briefId, title: digest.title });
  log(`BRIEF: minted signal ${signalId} for the operator's own idea.`);

  /**
   * Grounded research, attempted for every brief including a thin one.
   *
   * This is where a vague prompt is actually handled now: "make a video on
   * AI" gives the search a subject and no angle, and the search's own job is
   * to come back with the most contested thing it can find about it
   * (`langchain-research.ts`'s user prompt says exactly that). That is a
   * search over the live web for what the operator asked about, rather than
   * a lookup of what this system happened to ingest — which is the whole
   * reason the operator asked for the fallback to go.
   */
  let brief: ResearchBrief | null = null;
  let provenance: ResearchProvenanceLine | null = null;
  const grounded = await research({ title: digest.title, angle: digest.angle, mustInclude: digest.mustInclude });
  if (grounded === null) {
    log("RESEARCH: grounded research did not produce a brief — the render will try the corpus path.");
  } else {
    brief = grounded.brief;
    provenance = grounded.provenance;
    log(`RESEARCH: grounded on ${grounded.brief.model} — ${grounded.brief.citations.length} citation(s).`);
  }

  /**
   * A real run plan, which is what makes every stage after SCRIPT work
   * unchanged: `claimNextRunPick` claims from it, and `claimedPick.topic` then
   * drives PLAN's prompt, SOURCE's topic-aware YouTube download cap and
   * EXPORT's hashtags — three things that would each have needed a
   * brief-shaped special case if this route had invented its own way to name
   * a story.
   */
  const planId = await queueRunPlan(rawClient, [{ topic: digest.topic, signalId }]);

  return { planId, signalId, digest, research: brief, researchProvenance: provenance, digestDegradedReason: degradedReason };
}
