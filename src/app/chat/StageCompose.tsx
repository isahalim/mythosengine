import { useCallback, useEffect, useRef, useState } from "react";
import { describeError, isUnauthorized, listBriefs, submitBrief } from "../api.ts";
import type { BriefView } from "../types.ts";
import { parseDigest } from "../types.ts";
import { StageFrame } from "../ui/StageFrame.tsx";

/**
 * The chat route's first screen — panel 1 of the chat design board.
 *
 * One input, centred, with a `+` on the left and a submit on the right. The
 * placeholder cycles, fading in and out, and the whole cue greys out and
 * disappears the moment the operator types. There is no caret drawn beside
 * it (operator direction, 2026-09-05): the field is empty and unfocused, so
 * a blinking bar there was a caret the operator did not have — it invited a
 * click that had already happened and did nothing to say "type" that the
 * cue's own text was not saying.
 *
 * **The placeholder text is static copy, not model-generated.** The design
 * board's note beside it reads "use gemini 3.7 flash for now" — there is no
 * such model id in `src/config/models.ts`, and more to the point this is the
 * one surface in the product that must render before any network call
 * resolves. A cycling hint that waited on a model would be a blank input on
 * every cold load. Flagged rather than quietly invented.
 *
 * **What submitting does.** `POST /console/briefs` stores the prompt and the
 * files and dispatches a run. It does not answer any question about the idea
 * — the Worker makes no model call (CLAUDE.md), so the topic, the title and
 * whether the prompt was specific enough are all decided by DIGEST on the
 * runner and written back onto the brief. That is why the operator moves
 * straight to the building screen rather than waiting here for a reply: the
 * orb rising IS the acknowledgement, exactly as the board draws it.
 */

/** The cue the board names, first and longest. The rest are examples of the shape a good prompt has. */
const PLACEHOLDERS = [
  "Shatter into Reality",
  "Why every AI safety debate collapses into the same two people",
  "The quiet reason streaming prices all moved at once",
  "Make a video on AI",
];

const PLACEHOLDER_MS = 3_600;

/** Matches `MAX_BRIEF_ATTACHMENTS` / `MAX_BRIEF_ATTACHMENT_BYTES` / `MAX_BRIEF_PROMPT_CHARS` in src/server/console/briefs.ts. Checked here so a refusal is instant, and there too because a client check is not a rule. */
const MAX_FILES = 5;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_PROMPT_CHARS = 4_000;
const ACCEPT = ".txt,.md,.csv,.json,.pdf,.png,.jpg,.jpeg,.webp,.gif";

interface StageComposeProps {
  onSubmitted: (brief: BriefView, note: string | null, prompt: string) => void;
  onUnauthorized: () => void;
}

function kilobytes(bytes: number): string {
  return bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1000))} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** One line of history. Says what happened to a brief, in the brief's own words where it has any. */
function historyLine(brief: BriefView): string {
  const digest = parseDigest(brief);
  if (brief.status === "failed") return brief.failureReason ?? "failed";
  if (digest === null) return brief.status;
  return `${brief.status} · ${digest.topic}`;
}

export function StageCompose({ onSubmitted, onUnauthorized }: StageComposeProps) {
  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<BriefView[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [cue, setCue] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

  // The cue only cycles while the field is empty. Once there is text the
  // whole placeholder is gone, so animating it would be spending frames on
  // something nobody can see.
  useEffect(() => {
    if (prompt.length > 0) return;
    const id = window.setInterval(() => setCue((n) => (n + 1) % PLACEHOLDERS.length), PLACEHOLDER_MS);
    return () => window.clearInterval(id);
  }, [prompt.length]);

  useEffect(() => {
    let cancelled = false;
    void listBriefs().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setHistory(result.value);
        return;
      }
      if (isUnauthorized(result.error)) {
        onUnauthorized();
        return;
      }
      // A history that cannot be read must never stop the operator writing a
      // new brief — it is context, not a precondition.
      setHistory([]);
      setHistoryError(`Past briefs could not be loaded: ${describeError(result.error)}`);
    });
    return () => {
      cancelled = true;
    };
  }, [onUnauthorized]);

  const addFiles = useCallback(
    (incoming: FileList | null) => {
      if (incoming === null) return;
      setError(null);
      const next = [...files, ...Array.from(incoming)];
      if (next.length > MAX_FILES) {
        setError(`At most ${MAX_FILES} files.`);
        return;
      }
      const total = next.reduce((sum, file) => sum + file.size, 0);
      if (total > MAX_TOTAL_BYTES) {
        setError(`Attachments are capped at ${kilobytes(MAX_TOTAL_BYTES)} in total — this is ${kilobytes(total)}.`);
        return;
      }
      setFiles(next);
    },
    [files],
  );

  const submit = useCallback(async () => {
    const trimmed = prompt.trim();
    if (trimmed.length === 0 || busy) return;
    if (trimmed.length > MAX_PROMPT_CHARS) {
      setError(`That prompt is ${trimmed.length} characters; the cap is ${MAX_PROMPT_CHARS}.`);
      return;
    }

    setBusy(true);
    setError(null);
    const result = await submitBrief(trimmed, files);
    setBusy(false);

    if (!result.ok) {
      if (isUnauthorized(result.error)) {
        onUnauthorized();
        return;
      }
      setError(`That could not be submitted: ${describeError(result.error)}`);
      return;
    }
    onSubmitted(result.value.brief, result.value.note, trimmed);
  }, [prompt, files, busy, onSubmitted, onUnauthorized]);

  const empty = prompt.length === 0;

  return (
    <StageFrame
      eyebrow="Step 1 of 3"
      title="Tell it what to make"
      blurb="One idea, in your own words. Attach anything that helps. Whatever you type is what gets built — a bare subject just sends the research stage looking for the most contested thing in it."
    >
      <div className="pointer-events-auto mx-auto flex h-full w-full max-w-2xl flex-col">
        <div className="relative shrink-0">
          <div className="flex items-center gap-2 rounded-full border border-hairline bg-slate/60 px-2 py-2 shadow-[var(--shadow-1)] backdrop-blur">
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={busy}
              aria-label="Attach a file"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-hairline text-bone transition-colors hover:border-mercury/40 hover:text-mercury disabled:opacity-40"
            >
              +
            </button>
            <input ref={fileInput} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => addFiles(e.target.files)} />

            <div className="relative min-w-0 flex-1">
              <input
                type="text"
                value={prompt}
                disabled={busy}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit();
                }}
                aria-label="Your idea"
                className="w-full bg-transparent text-sm text-mercury outline-none placeholder:text-transparent disabled:opacity-60"
              />
              {/* The cue lives beside the input rather than in `placeholder`,
                  because a native placeholder cannot cross-fade.
                  `pointer-events-none` so clicking it still focuses the field
                  underneath. */}
              {empty && (
                <span key={cue} className="chat-cue pointer-events-none absolute inset-y-0 left-0 flex items-center text-sm text-bone">
                  {PLACEHOLDERS[cue]}
                </span>
              )}
            </div>

            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || prompt.trim().length === 0}
              aria-label="Shatter into reality"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-mercury text-ink transition-opacity disabled:opacity-25"
            >
              {busy ? "…" : "↑"}
            </button>
          </div>

          {files.length > 0 && (
            <ul className="mt-3 flex flex-wrap justify-center gap-2">
              {files.map((file, i) => (
                <li key={`${file.name}-${i}`} className="flex items-center gap-2 rounded-full border border-hairline bg-slate/40 px-3 py-1 text-xs text-bone">
                  <span className="max-w-[14rem] truncate">{file.name}</span>
                  <span className="text-bone/60">{kilobytes(file.size)}</span>
                  <button type="button" aria-label={`Remove ${file.name}`} onClick={() => setFiles(files.filter((_, n) => n !== i))} className="text-bone/60 hover:text-mercury">
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}

          {error !== null && <p className="mt-3 text-center text-xs text-rose">{error}</p>}
        </div>

        <section className="mt-8 min-h-0 flex-1 overflow-y-auto">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.22em] text-bone">History</h2>
          {history === null && <p className="mt-3 text-xs text-bone/60">Loading…</p>}
          {historyError !== null && <p className="mt-3 text-xs text-rose">{historyError}</p>}
          {history !== null && history.length === 0 && historyError === null && <p className="mt-3 text-xs text-bone/60">Nothing yet. The first thing you type will appear here.</p>}
          {history !== null && history.length > 0 && (
            <ul className="mt-3 space-y-2">
              {history.map((brief) => (
                <li key={brief.id} className="border-b border-hairline pb-2">
                  <p className="truncate text-sm text-mercury">{brief.prompt}</p>
                  <p className="mt-0.5 font-mono text-[0.65rem] text-bone">{historyLine(brief)}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </StageFrame>
  );
}
