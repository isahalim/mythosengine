// Small pure formatters, Intl-only — no new dependency.

const relativeFormatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
// Upper bound (seconds) -> unit to switch to once the delta clears it.
const UNIT_STEPS: [upperBoundS: number, unit: Intl.RelativeTimeFormatUnit, unitSeconds: number][] = [
  [60, "second", 1],
  [3600, "minute", 60],
  [86400, "hour", 3600],
  [2592000, "day", 86400],
  [31536000, "month", 2592000],
];

const FALLBACK_STEP: (typeof UNIT_STEPS)[number] = [Infinity, "year", 31536000];

export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const deltaS = (new Date(iso).getTime() - now.getTime()) / 1000;
  const absS = Math.abs(deltaS);

  const [, unit, unitSeconds] = UNIT_STEPS.find(([upperBoundS]) => absS < upperBoundS) ?? FALLBACK_STEP;
  return relativeFormatter.format(Math.round(deltaS / unitSeconds), unit);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
