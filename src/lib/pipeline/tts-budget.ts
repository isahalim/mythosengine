import type { KvLike } from "../drivers/cache-kv.ts";
import { QUOTAS } from "../../config/quotas.ts";

/**
 * How many Gemini TTS requests today has already spent, and the record of
 * each one.
 *
 * **Why this exists at all.** `selectTtsDrivers` used to answer "is the
 * upgrade still available?" by counting `renders` rows whose `tts_driver`
 * said `gemini-tts`. That count was wrong in three separate ways, and on
 * 2026-09-02 all three lined up: the operator asked for Kore, the pipeline
 * believed it had spent nothing, Gemini answered
 * `Quota exceeded ... limit: 10, model: gemini-3.1-flash-tts`, and the
 * video shipped narrated by `en-US-GuyNeural`.
 *
 * 1. **It counted the wrong day.** The row filter started at midnight
 *    *UTC*; Gemini's free-tier RPD resets at midnight *Pacific*. For the
 *    seven or eight hours between them — 5pm to midnight PT, which is
 *    exactly when this operator runs the pipeline — the counter read zero
 *    while the real quota was still yesterday's, fully spent.
 *
 * 2. **It counted successes, not requests.** A render that asked Gemini and
 *    fell back to Edge writes `tts_driver = 'edge-tts'`; a render that died
 *    at SOURCE after synthesizing writes no row at all. Both spent the
 *    quota. Only a request-shaped ledger can count requests.
 *
 * 3. **It only saw renders that reached the database it was reading.** A
 *    `PIPELINE_LOCAL=1` run writes to a SQLite file, so its Gemini requests
 *    were invisible to the production count and vice versa — while Google
 *    counts them all against the same key.
 *
 * The third one this cannot fully fix: usage from another machine, another
 * project or the AI Studio console is not visible from here, and no local
 * ledger can be authoritative about a remote counter. What it can do is
 * stop *this* pipeline being the thing that surprises itself, and record
 * enough that the operator can see where the ten went.
 *
 * Stored in KV rather than D1 because it is hot, per-day, disposable state
 * with a natural TTL — exactly what ARCHITECTURE.md §0 keeps there — and
 * because it needs no migration to start working.
 */

/** Two days, so yesterday's ledger is still readable while today's is being written, and neither outlives its usefulness. */
const LEDGER_TTL_SECONDS = 2 * 86_400;

/**
 * Gemini free-tier quotas reset at midnight America/Los_Angeles (Google's
 * own documented reset for the free tier), so that — not UTC, and not the
 * runner's local zone — is the day this budget is keyed by.
 *
 * `en-CA` gives ISO order (`2026-09-01`) directly from the formatter, so
 * there is no arithmetic here to get a DST transition wrong.
 */
export function geminiQuotaDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function ledgerKey(day: string): string {
  return `gemini-tts-ledger:${day}`;
}

/** One attempt: when it was made, and what came of it. Kept so "where did the ten go?" is answerable. */
interface GeminiTtsAttempt {
  at: string;
  renderTrace: string | null;
  outcome: "attempted" | "succeeded" | "failed";
  reason?: string;
}

interface Ledger {
  day: string;
  attempts: GeminiTtsAttempt[];
}

/** Null when the stored value exists but cannot be read as a ledger — which is not the same as "nothing spent today". */
function parseLedger(raw: string | null, day: string): Ledger | null {
  if (raw === null) return { day, attempts: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const attempts = (parsed as { attempts?: unknown }).attempts;
  if (!Array.isArray(attempts)) return null;
  return { day, attempts: attempts.filter((a): a is GeminiTtsAttempt => typeof a === "object" && a !== null && typeof (a as GeminiTtsAttempt).at === "string") };
}

export interface GeminiTtsBudget {
  day: string;
  /** Requests this pipeline has already sent today, counting the ones that failed. */
  spent: number;
  /** How many more it will send before falling back to Edge (`QUOTAS.gemini.ttsRequestsPerDayBudget`). */
  budget: number;
  /**
   * False when a stored ledger existed but could not be read. `spent` is
   * then the *whole* budget, not zero: an unreadable ledger says nothing
   * about today's spend, and the safe reading of "I don't know" is to leave
   * the remaining requests for a run that does know — never to assume a
   * fresh day and spend into a quota that may already be gone.
   */
  readable: boolean;
}

export async function readGeminiTtsBudget(kv: KvLike, now: Date = new Date()): Promise<GeminiTtsBudget> {
  const day = geminiQuotaDay(now);
  const budget = QUOTAS.gemini.ttsRequestsPerDayBudget;
  const ledger = parseLedger(await kv.get(ledgerKey(day)), day);
  if (ledger === null) return { day, spent: budget, budget, readable: false };
  return { day, spent: ledger.attempts.length, budget, readable: true };
}

/**
 * Records a request **before it is sent**.
 *
 * Deliberately not after: a process killed mid-synthesis, or a render that
 * throws at the next stage, has still spent the request as far as Google is
 * concerned. Counting on the way out would let a crash loop empty the day's
 * budget while the ledger read zero — the exact failure mode this whole
 * file exists to end.
 *
 * Read-modify-write on KV is not atomic, so two renders starting in the
 * same second could each write a ledger of one. RENDER is serialized by
 * `concurrency: pipeline-render` and runs one video per process, so that
 * race does not exist today; if it ever does, the cost is an
 * under-count that Gemini's own 429 still catches.
 */
export async function recordGeminiTtsAttempt(kv: KvLike, renderTrace: string | null, now: Date = new Date()): Promise<void> {
  const day = geminiQuotaDay(now);
  // An unreadable ledger is replaced rather than appended to, and this
  // attempt is the first entry of the new one. The caller only reaches here
  // when `readGeminiTtsBudget` said there was budget, which an unreadable
  // ledger never does.
  const ledger = parseLedger(await kv.get(ledgerKey(day)), day) ?? { day, attempts: [] };
  ledger.attempts.push({ at: now.toISOString(), renderTrace, outcome: "attempted" });
  await kv.put(ledgerKey(day), JSON.stringify(ledger), { expirationTtl: LEDGER_TTL_SECONDS });
}

/**
 * Google's own words for "you have used the whole day", as distinct from
 * "you are going too fast".
 *
 * Both arrive as HTTP 429 and they call for opposite responses: a
 * per-minute burst is worth waiting out, and an exhausted day is worth
 * writing down so the next nine renders do not each discover it for
 * themselves. The quota metric is named in the body, so this reads it
 * rather than guessing from the status code.
 */
function isDailyQuotaExhausted(reason: string): boolean {
  return /generate_content_free_tier_requests|per day|PerDay|RequestsPerDay/i.test(reason);
}

/**
 * Closes out the most recent attempt with what actually happened, so the
 * ledger reads as a history rather than a tally.
 *
 * A daily-quota 429 does more than annotate: it fills the ledger to the
 * budget, because the provider has just said authoritatively that there is
 * nothing left until midnight Pacific. Without that, every render for the
 * rest of the day repeats the same doomed request — which is how a ceiling
 * of ten gets crossed by a pipeline that thinks it is spending three.
 */
export async function settleGeminiTtsAttempt(kv: KvLike, outcome: "succeeded" | "failed", reason: string | null, now: Date = new Date()): Promise<void> {
  const day = geminiQuotaDay(now);
  const ledger = parseLedger(await kv.get(ledgerKey(day)), day);
  if (ledger === null) return;
  const last = ledger.attempts[ledger.attempts.length - 1];
  if (last === undefined) return;
  last.outcome = outcome;
  if (reason !== null) last.reason = reason;

  if (outcome === "failed" && reason !== null && isDailyQuotaExhausted(reason)) {
    const note = `Gemini reported the daily quota exhausted at ${now.toISOString()}; the rest of today's budget is written off rather than re-tried`;
    while (ledger.attempts.length < QUOTAS.gemini.ttsRequestsPerDayBudget) {
      ledger.attempts.push({ at: now.toISOString(), renderTrace: last.renderTrace, outcome: "failed", reason: note });
    }
  }

  await kv.put(ledgerKey(day), JSON.stringify(ledger), { expirationTtl: LEDGER_TTL_SECONDS });
}
