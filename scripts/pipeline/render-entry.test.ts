import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `render.ts` must run its pipeline **only when it is the process**, never
 * when it is merely imported.
 *
 * This is a regression test for a specific, expensive near-miss on
 * 2026-09-04. `scripts/pipeline/chat-render.ts` imports `renderOneVideo` from
 * `render.ts`, and `render.ts` called `main()` at module scope — so importing
 * it *started a brainstorm render*: a second, unrelated video, claiming a
 * queued pick from an earlier session and spending the day's token budget,
 * alongside the chat run the operator actually asked for. It was found by
 * reading a stack trace that contained two `main` frames.
 *
 * **Why this is a source assertion rather than a behavioural one.** The
 * failure only reproduces by importing the module for real, and importing it
 * for real is exactly the thing that would fire the pipeline — a test that
 * reproduced the bug would be a test that ran a render. Vitest module mocking
 * cannot help either: the guard is evaluated at module scope, before any mock
 * of `buildPipelineEnv` could take effect on the import that matters.
 *
 * So the invariant is checked where it is cheap and total: the file must not
 * call `main()` unconditionally.
 */
describe("render.ts's entry guard", () => {
  const source = readFileSync(join(process.cwd(), "scripts", "pipeline", "render.ts"), "utf8");

  it("does not call main() at module scope", () => {
    // An unconditional `main()` at the start of a line is the shape of the
    // bug. Inside the guard it is indented.
    expect(source).not.toMatch(/^main\(\)/m);
  });

  it("guards the call on this file being the process entry point", () => {
    expect(source).toContain("import.meta.url === pathToFileURL(process.argv[1] ?? \"\").href");
    expect(source).toMatch(/if \(import\.meta\.url === pathToFileURL[\s\S]{0,120}main\(\)/);
  });

  it("still exports the function the chat route imports", () => {
    // The other half of the contract: guarding the entry point must not have
    // made `renderOneVideo` unreachable, which is the only reason chat-render
    // imports this module at all.
    expect(source).toMatch(/export async function renderOneVideo\(/);
  });

  it("holds for chat-render.ts too, which imports render.ts", () => {
    // Not a guard — chat-render is only ever a process — but it must not
    // itself be importable-with-side-effects, in case something imports it
    // later for the same reason it imports render.ts.
    const chat = readFileSync(join(process.cwd(), "scripts", "pipeline", "chat-render.ts"), "utf8");
    expect(chat).toMatch(/^main\(\)\.catch\(/m);
    // If that ever needs to change, it changes with a guard, and this test is
    // the place that says so.
  });
});
