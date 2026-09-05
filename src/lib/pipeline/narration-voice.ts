import { HOST_GEMINI_VOICE } from "./character.ts";

/**
 * Which voice each TTS path actually uses for this render, and what a
 * request this system could not honour cost (operator direction, 2026-09-04).
 *
 * **Kore and English are the defaults, and they stay the defaults.** Nothing
 * here changes what a brainstorm-route render does: with no request, the
 * Gemini path is `HOST_GEMINI_VOICE` and the Edge path is the diversity
 * rotation, exactly as before. This function exists for the chat route, where
 * the operator may name a voice or a language in their prompt.
 *
 * **Why the two paths are asymmetric — and why that is the provider's fact,
 * not a decision made here.** Gemini TTS takes a `voice` as a real request
 * field and has **no language field at all**: its whole body is model, input,
 * response format and a speech config carrying one voice name
 * (`src/lib/drivers/tts-gemini.ts`). Its only lever for a language is prose
 * in the input, which is why a language request comes back out of here as a
 * *direction* rather than as a parameter. Edge is the mirror image: it has no
 * style direction at all, and the locale is encoded **in the voice name**
 * (`en-GB-SoniaNeural`), so changing the language there means choosing a
 * different voice or admitting there isn't one.
 *
 * **Why an unmet request is reported rather than absorbed.** A request for
 * Spanish that arrives in English is the same class of failure as the
 * 2026-09-02 export that said `Kore` and spoke `en-US-GuyNeural`: the video
 * is fine, and the record of it is a lie. So this returns `unmetRequest`,
 * RENDER logs it, and the audit package's `narration.voice` continues to say
 * what actually spoke.
 */

/**
 * BCP-47 prefixes for the languages the Edge voice pool can actually speak.
 *
 * Deliberately just English: `DEFAULT_VOICE_POOL` is eight English voices
 * across four accents, and claiming any other language would be claiming a
 * voice this deployment does not have. Adding one means adding real voice
 * ids to `src/config/voices.ts`, confirmed against `edge-tts --list-voices`
 * the way that file's own header describes — never guessed here.
 */
const EDGE_LANGUAGES: Record<string, string> = {
  english: "en",
};

/** The Gemini prebuilt voices this system will accept by name. Anything else is refused rather than sent and rejected by the provider. */
const GEMINI_VOICES = new Set([
  "Kore",
  "Puck",
  "Charon",
  "Fenrir",
  "Aoede",
  "Leda",
  "Orus",
  "Zephyr",
]);

export interface NarrationVoiceRequest {
  /** A voice the operator named, or null. */
  requestedVoice: string | null;
  /** A language the operator named, in plain words ("Spanish"), or null for English. */
  requestedLanguage: string | null;
  /** What the diversity rotation picked for the Edge path — the default when nothing was requested. */
  rotatedEdgeVoice: string;
}

export interface NarrationVoiceChoice {
  /** The voice the Gemini path will use. `HOST_GEMINI_VOICE` unless the operator named a real prebuilt voice. */
  geminiVoice: string;
  /** The voice the Edge path will use if it has to speak. The rotation's pick unless a request changed it. */
  edgeVoice: string;
  /**
   * A sentence to prepend to Gemini's style direction, or null.
   *
   * Non-null only when a language other than English was asked for. It is a
   * direction because the provider has no parameter — see the header.
   */
  geminiLanguageDirection: string | null;
  /** What could not be honoured, ready for the render log and the operator. Null when everything was. */
  unmetRequest: string | null;
}

/** Case-insensitive match against the prebuilt set, returning the provider's own spelling. */
function normalizeGeminiVoice(requested: string): string | null {
  for (const voice of GEMINI_VOICES) {
    if (voice.toLowerCase() === requested.trim().toLowerCase()) return voice;
  }
  return null;
}

/** The Edge voice for a language, or null when the pool has none. Prefers a voice already in the rotation's locale family. */
function edgeVoiceForLanguage(language: string, pool: readonly string[]): string | null {
  const prefix = EDGE_LANGUAGES[language.trim().toLowerCase()];
  if (prefix === undefined) return null;
  return pool.find((voice) => voice.toLowerCase().startsWith(`${prefix}-`)) ?? null;
}

export function resolveNarrationVoices(request: NarrationVoiceRequest, edgePool: readonly string[] = [request.rotatedEdgeVoice]): NarrationVoiceChoice {
  const unmet: string[] = [];

  let geminiVoice = HOST_GEMINI_VOICE;
  let edgeVoice = request.rotatedEdgeVoice;

  if (request.requestedVoice !== null && request.requestedVoice.trim().length > 0) {
    const prebuilt = normalizeGeminiVoice(request.requestedVoice);
    if (prebuilt !== null) {
      geminiVoice = prebuilt;
    } else if (/^[a-z]{2}-[A-Z]{2}-\w+Neural$/.test(request.requestedVoice.trim())) {
      // An Edge voice id, which the Gemini path cannot use. Honoured on the
      // path it belongs to, and said so for the other.
      edgeVoice = request.requestedVoice.trim();
      unmet.push(`"${request.requestedVoice.trim()}" is an Edge TTS voice, so it applies only if narration falls back to Edge — the Gemini path used ${HOST_GEMINI_VOICE}`);
    } else {
      unmet.push(`the requested voice "${request.requestedVoice.trim()}" is not one this system has — narration used ${HOST_GEMINI_VOICE} on Gemini and ${edgeVoice} on Edge`);
    }
  }

  let geminiLanguageDirection: string | null = null;
  const language = request.requestedLanguage?.trim() ?? "";
  const isEnglish = language.length === 0 || language.toLowerCase() === "english" || language.toLowerCase().startsWith("en");
  if (!isEnglish) {
    // Gemini can be asked; Edge can only be given a voice that already speaks it.
    geminiLanguageDirection = `Speak entirely in ${language}.`;
    const match = edgeVoiceForLanguage(language, edgePool);
    if (match === null) {
      unmet.push(
        `${language} was requested, and Gemini was directed to speak it — but the Edge voice pool has no ${language} voice, so a fallback to Edge would narrate in English. The audit package records which driver actually spoke`,
      );
    } else {
      edgeVoice = match;
    }
  }

  return { geminiVoice, edgeVoice, geminiLanguageDirection, unmetRequest: unmet.length === 0 ? null : unmet.join("; ") };
}
