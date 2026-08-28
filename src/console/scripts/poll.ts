// Shared polling helper: runs `task` on an interval, but pauses while the
// tab is hidden so a backgrounded console doesn't burn KV reads/rate limit
// for no one to see (ARCHITECTURE.md §10's KV read budget is finite).
export function startPolling(task: () => Promise<void>, intervalMs: number): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function tick(): Promise<void> {
    if (cancelled) return;
    if (document.visibilityState === "visible") {
      await task();
    }
    if (!cancelled) timer = setTimeout(tick, intervalMs);
  }

  void tick();

  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}
