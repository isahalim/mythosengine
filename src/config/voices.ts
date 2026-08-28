/**
 * Default curated Edge TTS voice pool — used when a directive's
 * `voice_pool` is null (ARCHITECTURE.md §5.6, CONSOLE_SPEC.md §3). Every id
 * below was confirmed against a real `edge-tts --list-voices` run
 * (2026-08-27, this session — see docs/DECISIONS.md), not guessed: these
 * are Microsoft's current short voice names, not values that happened to
 * look plausible.
 *
 * Mixed gender and English accent (US/GB/AU/IE) so `diversity_mode`'s
 * default "3 different voices a day" behavior actually sounds different
 * from one video to the next, not just three US-accented voices.
 */
export const DEFAULT_VOICE_POOL = [
  "en-US-GuyNeural",
  "en-US-AriaNeural",
  "en-GB-RyanNeural",
  "en-GB-SoniaNeural",
  "en-AU-NatashaNeural",
  "en-US-ChristopherNeural",
  "en-IE-ConnorNeural",
  "en-US-JennyNeural",
] as const;
