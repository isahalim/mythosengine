import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import react from "@astrojs/react";

// One route, one island. The six-stage surface (src/app/**) is the whole
// product and is mounted client:only from src/pages/index.astro — the
// glass, the spheres and the stage machine are one continuous client
// experience with nothing worth pre-rendering behind a passkey gate.
//
// The "one React island, everything else plain Astro + vanilla TS" rule
// this config used to record was lifted on 2026-08-31 by operator
// direction, when the console was replaced by that surface. React was
// already a dependency; no framework was added.
export default defineConfig({
  output: "static",
  outDir: "./dist",
  integrations: [react()],
  // The toolbar sits over the stage footer, where every stage's forward
  // action lives, and intercepts clicks on it.
  devToolbar: { enabled: false },
  vite: {
    plugins: [tailwindcss()],
    build: {
      rollupOptions: {
        output: {
          /**
           * The gradient orb gets a chunk of its own, named `orb`.
           *
           * Not a performance tweak — a budget boundary. `src/app/orb/**` is
           * the vendored 21st.dev component and it is the only thing here
           * that pulls in `three` and `@react-three/fiber`, roughly 170 KB
           * gzipped against the 110 KB the rest of the app is held to. A
           * deterministic chunk name is what lets `package.json`'s size-limit
           * exclude it from that budget by glob and give it its own, so the
           * app's budget keeps meaning "the app did not get heavier".
           *
           * `OrbLazy.tsx` is what makes the split actually load lazily; this
           * only decides what lands together and what it is called.
           */
          manualChunks(id) {
            if (id.includes("/src/app/orb/")) return "orb";
            if (id.includes("/node_modules/three/") || id.includes("/node_modules/@react-three/")) return "orb";
            return undefined;
          },
        },
      },
    },
  },
});
