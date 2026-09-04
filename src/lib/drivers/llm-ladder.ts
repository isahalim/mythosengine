import type { DriverError, LlmDriver, LlmRequest, LlmResponse } from "./types.ts";
import { err, ok, type Result } from "../result.ts";

/**
 * An `LlmDriver` that is an ordered list of models and takes the first one
 * that answers (operator direction, 2026-09-04).
 *
 * **Why this exists, given that `GeminiLadderDriver` was deleted for being
 * exactly this.** The deleted one laddered *within Gemini*, mid-tool-loop,
 * which meant handing a second model the first's signed `thought` steps —
 * untested, and a failure that only appears in production. This one is a
 * different shape: it descends **between whole requests**, and each rung is
 * sent the caller's own `messages` array, unmodified, with no provider state
 * from the rung above. That is a replay every driver here already supports,
 * because it is the same array a retry would send.
 *
 * The one thing it must never be used for is a Gemini→Gemini descent inside
 * a tool conversation, which is the case the 2026-09-02 decision ruled out.
 * `createReasoningLadder` below places at most one Gemini rung, at the top,
 * for that reason.
 *
 * **It falls through on any error.** Not on quota exhaustion, not on 429s
 * only: a 500, a timeout, a malformed body, a refusal. That specificity is
 * the whole lesson of the deleted `withGroqFallback`, which fired only on
 * exhaustion and let two `500 InternalServerError`s through to kill a
 * render at SCRIPT on 2026-09-01.
 *
 * **The descent is sticky.** Once a rung has failed, this driver does not
 * offer it again for the life of the instance — later calls start at the
 * highest rung that has not failed. A rate limit is a statement about the
 * next minute rather than about the last request, so re-offering a rung that
 * just refused spends a request to learn the same thing twice, and on a
 * 5-requests-per-minute meter it also spends the limiter's wait. One
 * instance is therefore one *stage*: SCRIPT falling back does not decide
 * where PLAN starts.
 *
 * **What it does not do.** It does not retry a rung (`fetchWithRetry` inside
 * each driver already owns that decision, and RESEARCH's Gemini driver
 * deliberately sets `maxAttempts: 1`), it does not inspect the response
 * beyond whether the driver returned one, and it does not know what a stage
 * is for. A rung that answers with something that fails schema validation
 * has answered — the caller's validator is what catches it, and on a repair
 * retry the same rung is asked again.
 */

/** One model on the ladder, and the driver that can reach it. */
export interface LadderRung {
  provider: "gemini" | "groq";
  model: string;
  llm: LlmDriver;
}

/** Which rung actually answered, ready for the audit package's `StageProvenance`. */
export interface LadderUse {
  provider: "gemini" | "groq";
  model: string;
  /**
   * Why this is not the top rung, or null when it is.
   *
   * Never null-and-silent on a descent. CLAUDE.md's NEVER block requires the
   * audit package to record which provider actually answered each reasoning
   * stage, and a reviewer comparing two exports has to be able to tell "the
   * top rung was rate-limited" from "the top rung wrote something unusable".
   * Neither is recoverable from the output.
   */
  fallbackReason: string | null;
}

export class LadderLlmDriver implements LlmDriver {
  /** The highest rung not yet known to be failing. Only ever moves down. */
  private floor = 0;
  /** Reasons the rungs above `floor` gave, oldest first — carried into `LadderUse.fallbackReason`. */
  private readonly descentReasons: string[] = [];
  private last: LadderUse | null = null;

  constructor(
    private readonly rungs: readonly LadderRung[],
    private readonly onEvent: (event: string) => void = (event) => console.warn(event),
  ) {
    // A zero-rung ladder would return a fabricated error from a stage that
    // never made a request, which reads in the audit package exactly like a
    // provider outage. Construction is the only place this can be caught.
    if (rungs.length === 0) throw new Error("LadderLlmDriver needs at least one rung");
  }

  /**
   * The rung that answered the most recent successful call, or null if none
   * has yet. RENDER reads this straight after each stage to record what
   * really wrote the thing.
   */
  lastUsed(): LadderUse | null {
    return this.last;
  }

  /** Every model on the ladder, top first — for a log line before anything has run. */
  describe(): string {
    return this.rungs.map((rung) => `${rung.provider}:${rung.model}`).join(" -> ");
  }

  /**
   * `req.model` is **ignored**, deliberately.
   *
   * The ladder is the answer to "which model", and a caller's default is
   * only there for the case where it is handed a plain driver instead (a
   * test, or a direct call). Honouring it would mean a stage could quietly
   * pin itself off the ladder, which is the drift `src/config/models.ts`
   * exists to prevent.
   */
  async complete(req: LlmRequest): Promise<Result<LlmResponse, DriverError>> {
    let lastError: DriverError | null = null;

    for (let index = this.floor; index < this.rungs.length; index++) {
      const rung = this.rungs[index];
      const completion = await rung.llm.complete({ ...req, model: rung.model });

      if (completion.ok) {
        this.last = {
          provider: rung.provider,
          model: rung.model,
          fallbackReason: this.descentReasons.length === 0 ? null : this.descentReasons.join("; "),
        };
        // `modelUsed` is the audit package's contract — the model that really
        // spoke, not the one the caller asked for. A rung that reports its
        // own is believed over the id we sent it.
        return ok({ ...completion.value, modelUsed: completion.value.modelUsed ?? rung.model });
      }

      lastError = completion.error;
      const reason = `${rung.provider}:${rung.model} failed (${completion.error.kind}: ${completion.error.message})`;
      this.descentReasons.push(reason);
      // Sticky: this rung is out for the rest of the stage. Recorded before
      // the next attempt so a run that dies mid-descent still says why.
      this.floor = index + 1;
      const below = this.rungs[index + 1];
      this.onEvent(below === undefined ? `${reason} — no rung left below it.` : `${reason} — stepping down to ${below.provider}:${below.model} for the rest of this stage.`);
    }

    // Every rung is spent. The last error is returned as-is rather than
    // wrapped: the caller's degrade path reads `kind`, and inventing a new
    // one would hide whether this was a rate limit or an outage.
    return err(
      lastError ?? {
        kind: "provider_error",
        message: `every model on the ladder had already failed: ${this.descentReasons.join("; ")}`,
        retryable: false,
      },
    );
  }
}
