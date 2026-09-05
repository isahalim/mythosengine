import { describe, expect, it } from "vitest";
import { HOST_GEMINI_VOICE } from "./character.ts";
import { resolveNarrationVoices } from "./narration-voice.ts";
import { DEFAULT_VOICE_POOL } from "../../config/voices.ts";

/**
 * Kore and English are the defaults and stay the defaults; a chat-route
 * brief may override either, per render.
 *
 * The tests that matter most are the ones about what happens when a request
 * *cannot* be honoured — this is the 2026-09-02 lesson (an export that said
 * `Kore` and spoke `en-US-GuyNeural`) applied to a new pair of knobs, and the
 * rule is that an unmet request is reported, never absorbed.
 */
describe("resolveNarrationVoices", () => {
  const ROTATED = "en-GB-SoniaNeural";

  it("changes nothing when nothing was requested — the brainstorm route's behaviour", () => {
    const choice = resolveNarrationVoices({ requestedVoice: null, requestedLanguage: null, rotatedEdgeVoice: ROTATED });

    expect(choice.geminiVoice).toBe(HOST_GEMINI_VOICE);
    expect(choice.edgeVoice).toBe(ROTATED);
    expect(choice.geminiLanguageDirection).toBeNull();
    expect(choice.unmetRequest).toBeNull();
  });

  it("honours a named prebuilt Gemini voice, case-insensitively, in the provider's own spelling", () => {
    expect(resolveNarrationVoices({ requestedVoice: "puck", requestedLanguage: null, rotatedEdgeVoice: ROTATED }).geminiVoice).toBe("Puck");
    expect(resolveNarrationVoices({ requestedVoice: " Kore ", requestedLanguage: null, rotatedEdgeVoice: ROTATED }).geminiVoice).toBe("Kore");
  });

  it("routes an Edge voice id to the Edge path and says the Gemini path could not use it", () => {
    const choice = resolveNarrationVoices({ requestedVoice: "en-AU-NatashaNeural", requestedLanguage: null, rotatedEdgeVoice: ROTATED });

    expect(choice.edgeVoice).toBe("en-AU-NatashaNeural");
    expect(choice.geminiVoice).toBe(HOST_GEMINI_VOICE);
    expect(choice.unmetRequest).toContain("Edge TTS voice");
  });

  it("refuses a voice this system does not have, rather than sending it and being rejected", () => {
    const choice = resolveNarrationVoices({ requestedVoice: "Brian Blessed", requestedLanguage: null, rotatedEdgeVoice: ROTATED });

    expect(choice.geminiVoice).toBe(HOST_GEMINI_VOICE);
    expect(choice.edgeVoice).toBe(ROTATED);
    expect(choice.unmetRequest).toContain("not one this system has");
  });

  it("treats English, and no language at all, as the same thing", () => {
    for (const language of [null, "", "English", "english", "en-GB"]) {
      const choice = resolveNarrationVoices({ requestedVoice: null, requestedLanguage: language, rotatedEdgeVoice: ROTATED });
      expect(choice.geminiLanguageDirection).toBeNull();
      expect(choice.unmetRequest).toBeNull();
    }
  });

  it("expresses a non-English language as Gemini direction, because Gemini has no language field", () => {
    const choice = resolveNarrationVoices({ requestedVoice: null, requestedLanguage: "Spanish", rotatedEdgeVoice: ROTATED }, DEFAULT_VOICE_POOL);

    expect(choice.geminiLanguageDirection).toBe("Speak entirely in Spanish.");
  });

  it("says outright that a fallback to Edge would narrate in English, rather than letting that happen silently", () => {
    const choice = resolveNarrationVoices({ requestedVoice: null, requestedLanguage: "Spanish", rotatedEdgeVoice: ROTATED }, DEFAULT_VOICE_POOL);

    // The pool is eight English voices; claiming Spanish would be claiming a
    // voice this deployment does not have.
    expect(choice.edgeVoice).toBe(ROTATED);
    expect(choice.unmetRequest).toContain("no Spanish voice");
    expect(choice.unmetRequest).toContain("audit package");
  });

  it("reports both failures at once when a brief asks for two things it cannot have", () => {
    const choice = resolveNarrationVoices({ requestedVoice: "Morgan Freeman", requestedLanguage: "Japanese", rotatedEdgeVoice: ROTATED }, DEFAULT_VOICE_POOL);

    expect(choice.unmetRequest).toContain("Morgan Freeman");
    expect(choice.unmetRequest).toContain("Japanese");
  });
});
