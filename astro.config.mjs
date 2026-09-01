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
  },
});
