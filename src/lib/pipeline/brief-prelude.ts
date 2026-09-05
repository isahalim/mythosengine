import type { AppDb, RawSqlClient } from "../../../db/client.ts";
import { queueRunPlan } from "../../../db/run-picks.ts";
import { rankIdeas } from "../../server/console/ideas.ts";
import type { LlmDriver } from "../drivers/types.ts";
import type { ResearchBrief } from "../rag/research.ts";
import type { StageProvenance } from "./audit.ts";
import { createOperatorSignal } from "./brief-signal.ts";
import { digestBrief, type BriefDigest } from "./digest.ts";

/**
 * The chat route's prelude: DIGEST, then the branch, then the run plan.
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
   * Grounded RESEARCH for a specific brief. Returns null on any failure — the
   * render then takes the corpus path, then `ungrounded`.
   *
   * Injected rather than called directly so this file has no opinion about
   * LangChain, and so the tests do not need a provider to exercise the branch.
   */
  research: (input: { title: string; angle: string; mustInclude: string[] }) => Promise<{ brief: ResearchBrief; provenance: ResearchProvenanceLine } | null>;
  /** Text read off the operator's attachments. Empty when there were none or none could be read. */
  attachmentText?: string;
  model?: string;
  log?: (message: string) => void;
}

/**
 * Runs the prelude. Returns **null** when there is nothing to build, which
 * happens only on the bare-topic branch against a corpus with nothing scored
 * for that topic.
 */
export async function prepareBrief(briefId: string, prompt: string, deps: BriefPreludeDeps): Promise<PreparedBrief | null> {
  const { db, rawClient, digestLlm, research, attachmentText = "", model, log = console.warn } = deps;

  const { digest, degradedReason } = await digestBrief(digestLlm, prompt, { attachmentText, ...(model === undefined ? {} : { model }) });
  if (degradedReason !== null) log(`DIGEST: ${degradedReason}`);
  log(`DIGEST: "${digest.title}" — ${digest.specificity}, topic ${digest.topic}${digest.angle.length > 0 ? `, angle: ${digest.angle}` : ""}.`);

  let signalId: string;
  let brief: ResearchBrief | null = null;
  let provenance: ResearchProvenanceLine | null = null;

  if (digest.specificity === "specific") {
    signalId = await createOperatorSignal(db, { briefId, title: digest.title });
    log(`BRIEF: minted signal ${signalId} for the operator's own idea.`);

    const grounded = await research({ title: digest.title, angle: digest.angle, mustInclude: digest.mustInclude });
    if (grounded === null) {
      log("RESEARCH: grounded research did not produce a brief — the render will try the corpus path.");
    } else {
      brief = grounded.brief;
      provenance = grounded.provenance;
      log(`RESEARCH: grounded on ${grounded.brief.model} — ${grounded.brief.citations.length} citation(s).`);
    }
  } else {
    /**
     * The bare-topic branch, and the part the operator asked to be
     * deterministic: **always idea #1**.
     *
     * `rankIdeas` is stage 4's own function, called with the arguments the
     * Ideas screen calls it with. No model orders this list — the ranking is
     * BM25 relevance blended with engagement and a recency weight — so the
     * same corpus and the same topic give the same answer, and the operator
     * can open that screen and see why this story won.
     */
    const ranked = await rankIdeas(db, digest.topic, 1, []);
    const top = ranked[0];
    if (top === undefined) return null;
    signalId = top.signalId;
    log(`BRIEF: "${prompt.trim()}" is a bare topic — taking the rank-1 ${digest.topic} idea, "${top.title}" (score ${top.score.toFixed(3)}).`);
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
