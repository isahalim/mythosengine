// Key vault row rendering + rotate/test wiring (CONSOLE_SPEC.md §2). The
// console never receives or displays a stored secret value — only
// fingerprint/last4/status come back from the summary; a rotation submits a
// *candidate* value once, and the input is cleared immediately after,
// success or failure, and never re-rendered into the DOM.
import { rotateKey, testKey } from "../lib/api.ts";
import { formatRelativeTime } from "../lib/format.ts";
import { LIVE_STATUS_DOT } from "../lib/status-style.ts";
import type { KeyStatus } from "../lib/types.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildKeyRow(key: KeyStatus): HTMLLIElement {
  const item = el("li", "flex flex-col gap-2 border-b border-mercury/10 py-2 last:border-0");

  const header = el("div", "flex items-center justify-between gap-3");
  header.appendChild(el("span", "font-mono text-xs uppercase tracking-wide text-mercury/80", key.name));
  const statusEl = el("span", "flex items-center gap-2 font-mono text-xs text-mercury/60");
  statusEl.appendChild(el("span", `h-2 w-2 rounded-full ${LIVE_STATUS_DOT[key.status]}`));
  statusEl.appendChild(
    document.createTextNode(key.lastValidatedAt ? `validated ${formatRelativeTime(key.lastValidatedAt)}` : "unvalidated"),
  );
  header.appendChild(statusEl);
  item.appendChild(header);

  if (!key.rotatable) return item;

  const form = el("form", "flex items-center gap-2");
  const input = document.createElement("input");
  input.type = "password";
  input.autocomplete = "off";
  input.placeholder = "new value";
  input.required = true;
  input.setAttribute("aria-label", `New value for ${key.name}`);
  input.className =
    "min-w-0 flex-1 rounded-md border border-mercury/20 bg-transparent px-2 py-1 font-mono text-xs text-mercury placeholder:text-mercury/40 focus-visible:outline-2 focus-visible:outline-sodium";

  const rotateButton = document.createElement("button");
  rotateButton.type = "submit";
  rotateButton.className = "shrink-0 rounded-md border border-sodium/40 px-3 py-1 font-mono text-xs text-sodium hover:bg-sodium/10";
  rotateButton.textContent = "Rotate";

  const testButton = document.createElement("button");
  testButton.type = "button";
  testButton.className = "shrink-0 rounded-md border border-mercury/20 px-3 py-1 font-mono text-xs text-mercury hover:border-mercury/40";
  testButton.textContent = "Test";

  const feedback = el("span", "font-mono text-xs text-mercury/50");

  // appendChild, not the variadic .append(a, b, c) — Cloudflare's generated
  // worker-configuration.d.ts declares a global HTMLRewriter `Element`
  // interface whose `append(content: string | ReadableStream | Response, …)`
  // merges with lib.dom's Element and breaks multi-argument .append() calls
  // project-wide (see docs/DECISIONS.md's Phase 7 entry). appendChild is
  // untouched by that merge.
  form.appendChild(input);
  form.appendChild(rotateButton);
  form.appendChild(testButton);
  item.appendChild(form);
  item.appendChild(feedback);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const candidate = input.value;
    input.value = "";
    void (async () => {
      rotateButton.disabled = true;
      feedback.textContent = "validating…";
      const result = await rotateKey(key.name, candidate);
      rotateButton.disabled = false;
      feedback.textContent = result.ok ? `rotated · …${result.value.last4}` : result.error.message;
      feedback.className = `font-mono text-xs ${result.ok ? "text-oxide" : "text-rose"}`;
    })();
  });

  testButton.addEventListener("click", () => {
    void (async () => {
      testButton.disabled = true;
      feedback.textContent = "testing…";
      const result = await testKey(key.name);
      testButton.disabled = false;
      feedback.textContent = result.ok ? "live" : result.error.message;
      feedback.className = `font-mono text-xs ${result.ok ? "text-oxide" : "text-rose"}`;
    })();
  });

  return item;
}

export function renderKeyList(containerId: string, keys: KeyStatus[]): void {
  const list = document.getElementById(containerId);
  if (!list) return;
  list.replaceChildren();
  for (const key of keys) list.appendChild(buildKeyRow(key));
}
