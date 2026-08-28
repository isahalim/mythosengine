/**
 * Parses a YouTube Data API `contentDetails.duration` value (ISO-8601
 * duration, e.g. "PT1H23M45S") into seconds. Pure function, no ffmpeg/API
 * dependency — trivially unit-testable on its own.
 */
export function parseIso8601Duration(value: string): number | null {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match) return null;
  const [, hours, minutes, seconds] = match;
  if (hours === undefined && minutes === undefined && seconds === undefined) return null;
  return Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0);
}
