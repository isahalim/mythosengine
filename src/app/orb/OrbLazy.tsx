import { lazy, Suspense } from "react";
import type { GradientOrbConfig } from "./GradientOrb.tsx";

/**
 * The only way the rest of this app is allowed to reach the gradient orb.
 *
 * `GradientOrb.tsx` is the vendored 21st.dev component, and it is the one
 * thing here that pulls in `three` and `@react-three/fiber` — about 170 KB
 * gzipped, against a 110 KB budget for the whole of the rest of the app's
 * JavaScript. Importing it directly anywhere would put that in the entry
 * chunk and every visitor would pay for it before the passkey prompt.
 *
 * So it is `lazy`, and `astro.config.mjs` gives everything under this
 * directory (plus `three`) a chunk named `orb`, which is what lets
 * `package.json`'s size-limit hold two budgets that mean different things:
 * the app's, which must not grow, and the orb's, which is what it is.
 *
 * The practical consequence: the landing, sign-in, the fork screen and the
 * entire five-stage brainstorm route download none of this. The bytes are
 * fetched the first time the operator opens the chat route, which is also the
 * first moment the orb is about to be visible.
 */

const GradientOrb = lazy(async () => ({ default: (await import("./GradientOrb.tsx")).GradientOrb }));

export interface OrbLazyProps {
  config?: GradientOrbConfig;
  className?: string;
}

/**
 * Renders nothing while the chunk is in flight — deliberately, rather than a
 * spinner or a placeholder circle.
 *
 * The orb's whole job on this screen is to *emerge* from the text input and
 * drift up. A stand-in that appeared first and was then replaced would break
 * exactly the moment the animation exists to create, and a fallback that
 * looked like the orb but was not it would be worse than a beat of nothing.
 */
export function OrbLazy({ config, className }: OrbLazyProps) {
  return (
    <Suspense fallback={null}>
      <GradientOrb config={config} className={className} />
    </Suspense>
  );
}
