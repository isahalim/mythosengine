// pino ships types for its default (Node) entry point but not for the
// explicit `pino/browser.js` entry src/server/log.ts imports (needed to
// deterministically avoid pino's fs-based Node transport under workerd —
// see the comment in log.ts). The browser build's factory has the same
// call signature as the main one, so this re-exports that existing type
// rather than redeclaring pino's API surface.
declare module "pino/browser.js" {
  import pino from "pino";
  export default pino;
}
