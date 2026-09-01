/**
 * Board 1: "Make all buttons have shadows, and pop effect on click."
 *
 * The shadow and the press are CSS (.btn in global.css). The pop is a
 * one-shot class applied on pointerup and removed when the animation
 * ends — a transition alone gives a squash with no rebound, which reads
 * as a dead button.
 */
import { useCallback, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  children: ReactNode;
}

const VARIANT_CLASS: Record<Variant, string> = {
  primary: "btn--primary",
  secondary: "",
  ghost: "btn--ghost",
};

export function Button({ variant = "secondary", className = "", children, onPointerUp, ...rest }: ButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);

  const pop = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.classList.remove("btn--pop");
    // Reading offsetWidth forces the style recalc that lets the same class
    // re-trigger its animation on a rapid second click.
    void el.offsetWidth;
    el.classList.add("btn--pop");
  }, []);

  return (
    <button
      ref={ref}
      className={`btn ${VARIANT_CLASS[variant]} px-5 py-2.5 text-sm ${className}`}
      onPointerUp={(e) => {
        if (!e.currentTarget.disabled) pop();
        onPointerUp?.(e);
      }}
      onAnimationEnd={() => ref.current?.classList.remove("btn--pop")}
      {...rest}
    >
      {children}
    </button>
  );
}
