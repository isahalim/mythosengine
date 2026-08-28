import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import react from "@astrojs/react";

// React integration added 2026-08-28 (docs/DECISIONS.md) specifically and
// only to mount PromptInputBox.tsx (src/console/components/) as an
// isolated island on /console/chat — every other page/component in this
// project stays plain Astro + vanilla TS. Astro's per-page code splitting
// keeps React/Radix/framer-motion out of every bundle that doesn't
// explicitly import the island.
export default defineConfig({
  output: "static",
  outDir: "./dist",
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
