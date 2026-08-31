import { fetchWithRetry } from "./http.ts";
import type { DriverError } from "./types.ts";
import { err, ok, type Result } from "../result.ts";

/**
 * Reads the plain text of one already-ingested article — the live-fetch leg
 * of the RESEARCH stage (ARCHITECTURE.md §5.2.5). Retrieval gives the agent
 * headlines; this gives it what the headline was actually about.
 *
 * **The URL is never chosen by the model.** `ResearchAgent`'s `read_source`
 * tool takes a `signal_id`, resolves it through the retriever, and passes
 * the resulting `signals.canonical_url` here. The model cannot aim this at
 * an address of its own composing, which is what keeps a model-driven
 * fetcher running inside GitHub Actions from being a general-purpose
 * request forwarder. The scheme and host checks below are the second layer,
 * for a canonical_url that is itself junk — scraped feed data is untrusted
 * input, the same discipline youtube-search-dom.ts applies to video ids.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
/** Enough for any article's prose; small enough that a mis-typed content-type can't stream a video into memory. */
const DEFAULT_MAX_BYTES = 1_000_000;
/** What actually reaches the model, after stripping. Roughly 1.5K tokens — this is a research input, not a document store. */
const DEFAULT_MAX_CHARS = 6_000;

const USER_AGENT = "MythosEngine/1.0 (+research; contact via repository)";

export interface ArticleFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxChars?: number;
  fetchImpl?: typeof fetch;
}

export interface FetchedArticle {
  url: string;
  text: string;
  /** True when `text` stops at `maxChars` — recorded so a caller never mistakes a cut-off article for a short one. */
  truncated: boolean;
}

/**
 * Blocks a URL that resolves to somewhere only this runner can reach.
 * Hostname-level only, and deliberately not sold as complete: it stops the
 * obvious `localhost`/RFC-1918/link-local literals, and cannot stop a public
 * DNS name that points at a private address. The real containment is that
 * every URL here came from a `signals` row, not from the model.
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return true;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd")) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

/**
 * HTML to readable text. `<script>`, `<style>`, `<noscript>` and comments go
 * first — dropping their *contents*, not just their tags, or a page's
 * inline JSON blob becomes the "article". Block-level tags become newlines
 * so paragraph boundaries survive; everything else collapses to spaces.
 *
 * Not a readability implementation: it does not try to find the main
 * column, so nav and footer text comes along. That is an accepted quality
 * limit, not an oversight — the agent is asked for a grounded summary with
 * citations, and boilerplate is noise it can ignore, whereas a wrong
 * main-column guess silently discards the actual article.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|iframe)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/[ \t\u00A0]+/g, " ") // \u00A0 spelled out: a literal NBSP in a character class is invisible in review
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

export class ArticleFetchDriver {
  constructor(private readonly options: ArticleFetchOptions = {}) {}

  async fetchArticle(url: string): Promise<Result<FetchedArticle, DriverError>> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return err({ kind: "invalid_response", message: `not a URL: ${url}`, retryable: false });
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return err({ kind: "policy_violation", message: `refusing to fetch ${parsed.protocol} URL`, retryable: false });
    }
    if (isPrivateHost(parsed.hostname)) {
      return err({ kind: "policy_violation", message: `refusing to fetch a private-network host: ${parsed.hostname}`, retryable: false });
    }

    const maxBytes = this.options.maxBytes ?? DEFAULT_MAX_BYTES;
    const maxChars = this.options.maxChars ?? DEFAULT_MAX_CHARS;

    const response = await fetchWithRetry(
      parsed.toString(),
      { headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain" }, redirect: "follow" },
      { timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxAttempts: 2, baseDelayMs: 250, fetchImpl: this.options.fetchImpl },
    );
    if (!response.ok) return response;

    const contentType = response.value.headers.get("content-type") ?? "";
    if (contentType !== "" && !/text\/html|text\/plain|application\/xhtml/i.test(contentType)) {
      return err({ kind: "invalid_response", message: `expected HTML or text, got ${contentType}`, retryable: false });
    }

    const declaredLength = Number(response.value.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      return err({ kind: "policy_violation", message: `content-length ${declaredLength} exceeds the ${maxBytes}-byte ceiling`, retryable: false });
    }

    let body: string;
    try {
      const buffer = await response.value.arrayBuffer();
      // Checked again after reading: content-length is a claim, and a
      // chunked response doesn't make one at all.
      if (buffer.byteLength > maxBytes) {
        return err({ kind: "policy_violation", message: `body of ${buffer.byteLength} bytes exceeds the ${maxBytes}-byte ceiling`, retryable: false });
      }
      body = new TextDecoder("utf-8").decode(buffer);
    } catch (cause) {
      return err({ kind: "network", message: cause instanceof Error ? cause.message : String(cause), retryable: true });
    }

    const text = htmlToText(body);
    if (text.length === 0) {
      return err({ kind: "invalid_response", message: `no readable text at ${parsed.toString()}`, retryable: false });
    }

    return ok({
      url: parsed.toString(),
      text: text.slice(0, maxChars),
      truncated: text.length > maxChars,
    });
  }
}
