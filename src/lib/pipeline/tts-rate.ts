/**
 * Picks a random rate within a directive's `ttsRateRange` (e.g. `["-10%",
 * "+15%"]` — CONSOLE_SPEC.md §3), or the fixed default when unset
 * (ARCHITECTURE.md §5.6). `Number.parseInt` already handles the leading
 * `+`/`-` sign, so no separate regex is needed.
 */
export function pickTtsRate(range: readonly [string, string] | null, random: () => number = Math.random): string {
  if (!range) return "+0%";
  const min = Number.parseInt(range[0], 10);
  const max = Number.parseInt(range[1], 10);
  const value = Math.round(min + random() * (max - min));
  return value >= 0 ? `+${value}%` : `${value}%`;
}
