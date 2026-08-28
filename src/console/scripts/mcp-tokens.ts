// MCP access-token list + revoke, mirroring src/console/scripts/keys.ts's
// row pattern. Issuing a new token isn't wired here yet — CONSOLE_SPEC.md §2
// requires a fresh reauth nonce for it, and the console has no step-up-reauth
// UI to produce one yet (same gap key rotation's own UI already has).
import { revokeMcpToken } from "../lib/api.ts";
import { formatRelativeTime } from "../lib/format.ts";
import type { McpTokenSummary } from "../lib/types.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildMcpTokenRow(token: McpTokenSummary, onRevoked: () => void): HTMLLIElement {
  const item = el("li", "flex items-center justify-between gap-3 border-b border-mercury/10 py-2 last:border-0");

  const info = el("div", "flex flex-col");
  info.appendChild(el("span", "font-mono text-xs text-mercury/80", token.label));
  info.appendChild(
    el(
      "span",
      "font-mono text-[0.65rem] text-mercury/40",
      token.lastUsedAt ? `last used ${formatRelativeTime(token.lastUsedAt)}` : `issued ${formatRelativeTime(token.createdAt)}, never used`,
    ),
  );
  item.appendChild(info);

  const revokeButton = document.createElement("button");
  revokeButton.type = "button";
  revokeButton.className = "shrink-0 rounded-md border border-rose/30 px-3 py-1 font-mono text-xs text-rose hover:bg-rose/10";
  revokeButton.textContent = "Revoke";
  revokeButton.addEventListener("click", () => {
    void (async () => {
      revokeButton.disabled = true;
      const result = await revokeMcpToken(token.id);
      if (result.ok) onRevoked();
      else revokeButton.disabled = false;
    })();
  });
  item.appendChild(revokeButton);

  return item;
}

export function renderMcpTokenList(containerId: string, tokens: McpTokenSummary[], onRevoked: () => void): void {
  const list = document.getElementById(containerId);
  if (!list) return;
  list.replaceChildren();
  if (tokens.length === 0) {
    list.appendChild(el("li", "py-2 font-mono text-xs text-mercury/40", "No MCP clients authorized."));
    return;
  }
  for (const token of tokens) list.appendChild(buildMcpTokenRow(token, onRevoked));
}
