// Drives the --posX/--posY custom properties .gradient-interactive reads
// (src/styles/global.css), rAF-throttled exactly like the 21st.dev source
// this was ported from (see that file's header comment). Vanilla DOM, no
// framework — this codebase has no React/JSX anywhere.
export function initGradientInteractive(elementId: string, intensity = 1): () => void {
  const host = document.getElementById(elementId);
  if (!host) return () => {};

  const prefersReduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (prefersReduced) return () => {};

  let raf = 0;
  let pending: { clientX: number; clientY: number } | null = null;

  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!pending) return;
      const rect = host.getBoundingClientRect();
      const x = (pending.clientX - rect.left - rect.width / 2) * intensity;
      const y = (pending.clientY - rect.top - rect.height / 2) * intensity;
      host.style.setProperty("--posX", String(x));
      host.style.setProperty("--posY", String(y));
    });
  };

  const onPointerMove = (event: PointerEvent) => {
    pending = event;
    schedule();
  };
  const onTouchMove = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (touch) {
      pending = touch;
      schedule();
    }
  };
  const reset = () => {
    host.style.setProperty("--posX", "0");
    host.style.setProperty("--posY", "0");
  };

  host.addEventListener("pointermove", onPointerMove, { passive: true });
  host.addEventListener("touchmove", onTouchMove, { passive: true });
  host.addEventListener("pointerleave", reset);
  host.addEventListener("touchend", reset);

  return () => {
    host.removeEventListener("pointermove", onPointerMove);
    host.removeEventListener("touchmove", onTouchMove);
    host.removeEventListener("pointerleave", reset);
    host.removeEventListener("touchend", reset);
    if (raf) cancelAnimationFrame(raf);
  };
}
