import { GeminiTtsDriver } from "./tts-gemini.ts";
import type { TtsDriver } from "./types.ts";

/**
 * Gemini is a **narration** provider in this system and nothing else.
 *
 * It briefly drove RESEARCH, reranking, SCRIPT, PLAN and EDIT (2026-09-01);
 * the operator reverted that the same day after the first live run tripped
 * the free tier's 5 requests/minute text ceiling and lost a render. Every
 * reasoning stage is back on Groq — see `src/config/models.ts` for the
 * model and the reasoning. The LLM driver and its model ladder were
 * deleted rather than left dormant, so a `GEMINI_API_KEY` in the
 * environment now buys TTS and only TTS.
 *
 * The `createGeminiLimiter` that used to live here went with them: it paced
 * a per-minute burst the TTS driver never took (one call per video), and
 * the limit that actually binds narration is the daily one, enforced by
 * `resolveTtsDriver` (src/lib/pipeline/tts-select.ts) counting today's
 * renders.
 */

/**
 * The vault-free constructor for the GitHub Actions pipeline runner, which
 * has no binding to the console's key vault. Kept in `src/lib/drivers/**`
 * for the same convention `createGroqDriverFromEnv` follows: driver
 * construction lives here, not in the orchestrator scripts.
 */
export function createGeminiTtsDriverFromEnv(apiKey: string, testOverrides?: { baseUrl?: string; fetchImpl?: typeof fetch }): TtsDriver {
  return new GeminiTtsDriver({ apiKey, ...testOverrides });
}
