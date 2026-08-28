import { XMLParser } from "fast-xml-parser";
import type { DriverError } from "../drivers/types.ts";
import { err, ok, type Result } from "../result.ts";

export interface FeedItem {
  title: string;
  url: string;
  publishedAt: string; // ISO-8601 UTC
  /** 1-indexed position within the feed as returned — a ranking proxy for sources with no explicit score (ARCHITECTURE.md §5.2). */
  rank: number;
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "#text" in value) {
    const t = (value as { "#text": unknown })["#text"];
    return typeof t === "string" ? t : null;
  }
  return null;
}

function parseDateToIso(value: unknown): string | null {
  const text = textOf(value);
  if (text === null) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Parses RSS 2.0 or Atom XML into normalized items. Never regex over XML — a real parser, per CLAUDE.md's NEVER block. */
export function parseFeed(xml: string): Result<FeedItem[], DriverError> {
  let doc: unknown;
  try {
    doc = parser.parse(xml, true);
  } catch (cause) {
    return err({
      kind: "invalid_response",
      message: `malformed feed XML: ${cause instanceof Error ? cause.message : String(cause)}`,
      retryable: false,
    });
  }

  if (typeof doc !== "object" || doc === null) {
    return err({ kind: "invalid_response", message: "feed did not parse to an object", retryable: false });
  }

  const root = doc as Record<string, unknown>;

  if ("rss" in root) {
    return parseRss(root.rss);
  }
  if ("feed" in root) {
    return parseAtom(root.feed);
  }

  return err({ kind: "invalid_response", message: "not a recognized RSS or Atom document", retryable: false });
}

function parseRss(rssNode: unknown): Result<FeedItem[], DriverError> {
  if (typeof rssNode !== "object" || rssNode === null || !("channel" in rssNode)) {
    return err({ kind: "invalid_response", message: "RSS document has no <channel>", retryable: false });
  }
  const channel = (rssNode as { channel: unknown }).channel;
  if (typeof channel !== "object" || channel === null) {
    return err({ kind: "invalid_response", message: "RSS <channel> was not an object", retryable: false });
  }

  const items = toArray((channel as Record<string, unknown>).item);
  const result: FeedItem[] = [];
  items.forEach((item, index) => {
    if (typeof item !== "object" || item === null) return;
    const record = item as Record<string, unknown>;
    const title = textOf(record.title);
    const link = textOf(record.link);
    const publishedAt = parseDateToIso(record.pubDate);
    if (title === null || link === null || publishedAt === null) return;
    result.push({ title, url: link, publishedAt, rank: index + 1 });
  });

  return ok(result);
}

function parseAtom(feedNode: unknown): Result<FeedItem[], DriverError> {
  if (typeof feedNode !== "object" || feedNode === null) {
    return err({ kind: "invalid_response", message: "Atom <feed> was not an object", retryable: false });
  }

  const entries = toArray((feedNode as Record<string, unknown>).entry);
  const result: FeedItem[] = [];
  entries.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) return;
    const record = entry as Record<string, unknown>;
    const title = textOf(record.title);
    const publishedAt = parseDateToIso(record.published ?? record.updated);
    const link = extractAtomLink(record.link);
    if (title === null || link === null || publishedAt === null) return;
    result.push({ title, url: link, publishedAt, rank: index + 1 });
  });

  return ok(result);
}

function extractAtomLink(value: unknown): string | null {
  const links = toArray(value);
  for (const link of links) {
    if (typeof link === "object" && link !== null && "@_href" in link) {
      const href = (link as { "@_href": unknown })["@_href"];
      if (typeof href === "string") return href;
    }
  }
  return null;
}
