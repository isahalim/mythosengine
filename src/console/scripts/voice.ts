// Voice control: mic capture -> Groq Whisper transcript -> a tool-calling
// turn dispatched through MCP (src/server/mcp/server.ts) -> spoken reply via
// the browser's own SpeechSynthesis. Same vanilla-DOM, no-innerHTML
// discipline as every other console script (src/console/scripts/chat.ts).
import { sendVoiceTurn, transcribeVoice } from "../lib/api.ts";
import { startSiriWave } from "./siri-wave.ts";
import { redirectIfUnauthorized } from "../lib/session-guard.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function threadEl(): HTMLElement | null {
  return document.getElementById("voice-thread");
}
function statusEl(): HTMLElement | null {
  return document.getElementById("voice-status");
}
function appendBubble(role: "user" | "assistant" | "tool", text: string): void {
  const thread = threadEl();
  if (!thread) return;
  if (thread.children.length === 1 && thread.children[0].tagName === "LI" && thread.textContent?.includes("Hold the orb")) {
    thread.replaceChildren();
  }

  if (role === "tool") {
    const li = el("li", "mx-auto flex w-fit items-center gap-1.5 rounded-full border border-oxide/25 bg-oxide/10 px-3 py-1 font-body text-xs text-oxide", `Ran ${text}`);
    thread.appendChild(li);
    return;
  }

  const isUser = role === "user";
  const li = el(
    "li",
    isUser
      ? "ml-auto max-w-[75%] whitespace-pre-wrap rounded-3xl bg-mercury/10 px-4 py-2.5 font-body text-sm text-bone"
      : "max-w-[75%] whitespace-pre-wrap font-body text-[0.95rem] leading-relaxed text-mercury",
    text,
  );
  thread.appendChild(li);
  thread.scrollTop = thread.scrollHeight;
}

function setStatus(text: string): void {
  const node = statusEl();
  if (node) node.textContent = text;
}

/** Speaks `text` aloud via the browser's built-in speech synthesis — no server TTS call (see voice.astro's header comment for why). */
function speak(text: string): void {
  if (!("speechSynthesis" in window) || !text) return;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

const PREFERRED_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

function pickSupportedMimeType(): string | undefined {
  return PREFERRED_MIME_TYPES.find((type) => window.MediaRecorder?.isTypeSupported?.(type));
}

/** Starts the Siri-style GLSL wave (src/console/scripts/siri-wave.ts, sourced from 21st.dev) on the voice-wave canvas while the mic is live. */
function startWaveVisualizer(_stream: MediaStream): () => void {
  const canvas = document.getElementById("voice-wave");
  if (!(canvas instanceof HTMLCanvasElement)) return () => {};
  return startSiriWave(canvas);
}

/** Crossfades the idle Siri Orb button into the Siri Wave canvas and back — "the orb becomes the wave" the operator asked for, not two components with no visual relationship. */
function setRecordingVisual(button: HTMLButtonElement, active: boolean): void {
  const canvas = document.getElementById("voice-wave");
  button.style.opacity = active ? "0" : "1";
  if (canvas) canvas.style.opacity = active ? "1" : "0";
}

export function initVoice(): void {
  const buttonEl = document.getElementById("voice-record-button");
  if (!(buttonEl instanceof HTMLButtonElement)) return;
  const button: HTMLButtonElement = buttonEl;

  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let stopVisualizer: () => void = () => {};
  let activeSessionId: string | undefined;
  let recording = false;

  async function startRecording(): Promise<void> {
    if (recording) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("This browser can't access the microphone.");
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setStatus("Microphone permission denied.");
      return;
    }

    recording = true;
    chunks = [];
    setRecordingVisual(button, true);
    setStatus("Listening…");
    stopVisualizer = startWaveVisualizer(stream);

    const mimeType = pickSupportedMimeType();
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener("stop", () => {
      stream.getTracks().forEach((track) => track.stop());
      stopVisualizer();
      void handleRecordingComplete(new Blob(chunks, { type: mimeType ?? "audio/webm" }));
    });
    recorder.start();
  }

  function stopRecording(): void {
    if (!recording || !recorder) return;
    recording = false;
    setRecordingVisual(button, false);
    recorder.stop();
    recorder = null;
  }

  async function handleRecordingComplete(audio: Blob): Promise<void> {
    setStatus("Transcribing…");
    button.disabled = true;

    const transcribed = await transcribeVoice(audio);
    if (!transcribed.ok) {
      if (redirectIfUnauthorized(transcribed.error)) return;
      setStatus("Couldn't transcribe that — hold the orb and try again.");
      button.disabled = false;
      return;
    }

    const transcript = transcribed.value.transcript.trim();
    if (!transcript) {
      setStatus("Didn't catch anything — hold the orb and try again.");
      button.disabled = false;
      return;
    }

    appendBubble("user", transcript);
    setStatus("Thinking…");

    const turn = await sendVoiceTurn(transcript, activeSessionId);
    button.disabled = false;
    if (!turn.ok) {
      if (redirectIfUnauthorized(turn.error)) return;
      setStatus("Couldn't reach the console — hold the orb and try again.");
      return;
    }
    activeSessionId = turn.value.sessionId;

    for (const toolName of turn.value.toolCallsMade) appendBubble("tool", toolName);
    appendBubble("assistant", turn.value.finalMessage);
    speak(turn.value.finalMessage);
    setStatus("Hold the orb and speak");
  }

  button.addEventListener("mousedown", () => void startRecording());
  button.addEventListener("touchstart", (event) => {
    event.preventDefault();
    void startRecording();
  });
  button.addEventListener("mouseup", stopRecording);
  button.addEventListener("mouseleave", stopRecording);
  button.addEventListener("touchend", stopRecording);
}
