// Adapted from 21st.dev's "AI Prompt Box" (johuniq, id 10442 —
// https://21st.dev/@johuniq/components/ai-prompt-box). The only React
// component in this project — mounted as a single Astro island on
// /console/chat (astro.config.mjs, docs/DECISIONS.md) — everything else
// here is plain Astro + vanilla TS, so this stays deliberately small.
//
// Trimmed from the source component, not just re-themed: the original's
// file-attachment/image-preview dialog has no backing feature in this
// app (the chat agent doesn't accept images), and its "voice message"
// button was a `console.log` stub, not real recording — this app already
// has a real, working voice surface (/console/voice, MediaRecorder + Groq
// Whisper). Shipping either here would be exactly the fabricated,
// non-functional UI CLAUDE.md's rules warn against. What's kept is the
// actual reusable shape: the rounded pill composer, the auto-growing
// textarea, and the animated circular send button — re-tokened to this
// console's own palette (src/styles/tokens.css) instead of the source's
// hardcoded #1F2023/#444444 hex values.
//
// No onSend prop: Astro passes only serializable values across the island
// boundary, not functions, so this dispatches a "chat:send" CustomEvent
// that src/pages/console/chat.astro's inline script forwards into
// src/console/scripts/chat.ts's sendComposerMessage — one orchestration
// path, not a duplicate reimplementation inside the island.
import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import * as Tooltip from "@radix-ui/react-tooltip";
import { ArrowUp, Mic } from "lucide-react";

export interface PromptInputBoxProps {
  placeholder?: string;
}

const MAX_TEXTAREA_HEIGHT_PX = 240;

export function PromptInputBox({ placeholder = "Message AutoShorts AI…" }: PromptInputBoxProps) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`;
  }, [value]);

  useEffect(() => {
    const onBusyChange = (event: Event) => setBusy((event as CustomEvent<{ busy: boolean }>).detail.busy);
    window.addEventListener("chat:busy", onBusyChange);
    return () => window.removeEventListener("chat:busy", onBusyChange);
  }, []);

  const hasContent = value.trim().length > 0;

  function handleSubmit(): void {
    if (!hasContent || busy) return;
    window.dispatchEvent(new CustomEvent("chat:send", { detail: { content: value } }));
    setValue("");
  }

  return (
    <Tooltip.Provider delayDuration={300}>
      <div className="gradient-accent-border flex items-end gap-2 rounded-3xl border border-mercury/15 bg-slate/60 px-4 py-2 shadow-[0_8px_30px_rgba(0,0,0,0.24)]">
        <label htmlFor="prompt-input-textarea" className="sr-only">
          Message
        </label>
        <textarea
          id="prompt-input-textarea"
          ref={textareaRef}
          rows={1}
          value={value}
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              handleSubmit();
            }
          }}
          placeholder={placeholder}
          className="max-h-60 flex-1 resize-none bg-transparent py-2.5 font-body text-sm text-mercury placeholder:text-mercury/40 focus:outline-none disabled:opacity-50"
        />
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <motion.button
              type="button"
              aria-label={hasContent ? "Send message" : "Type a message to send"}
              disabled={!hasContent || busy}
              onClick={handleSubmit}
              whileHover={hasContent && !busy ? { scale: 1.05 } : undefined}
              whileTap={hasContent && !busy ? { scale: 0.95 } : undefined}
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed ${
                hasContent ? "bg-bone text-ink" : "bg-mercury/10 text-mercury/40"
              }`}
            >
              {hasContent ? <ArrowUp size={16} strokeWidth={2.2} /> : <Mic size={16} strokeWidth={2} aria-hidden="true" />}
            </motion.button>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content side="top" sideOffset={6} className="rounded-md border border-mercury/20 bg-ink px-2.5 py-1 font-body text-xs text-mercury shadow-lg">
              {hasContent ? "Send message" : "Type a message, or use /console/voice to talk instead"}
              <Tooltip.Arrow className="fill-ink" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </div>
    </Tooltip.Provider>
  );
}
