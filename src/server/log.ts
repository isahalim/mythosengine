import pino from "pino/browser.js";

// Cloudflare Workers (workerd) has no fs/worker_threads, so pino's default
// Node transport (sonic-boom, opens a real file descriptor) cannot run here
// — confirmed by trying it: a plain `import pino from "pino"` picks the
// Node build under `nodejs_compat` and ignores a `browser` option entirely,
// throwing when it tries to open its default destination. The explicit
// `pino/browser` entry point never touches fs; `write` below is the only
// thing that actually emits a line, straight to `console.log` as one JSON
// object per call, which is what the Workers log tail actually captures.
export const log = pino({
  browser: {
    asObject: true,
    write: (obj: unknown) => {
      console.log(JSON.stringify(obj));
    },
  },
});
