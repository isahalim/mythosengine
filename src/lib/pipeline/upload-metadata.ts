import { z } from "zod";
import type { DriverError, LlmDriver } from "../drivers/types.ts";
import { GROQ_LIGHT_MODEL } from "../../config/models.ts";
import { extractKeywords } from "./keywords.ts";

/**
 * The title, description and hashtags the operator pastes into YouTube
 * Studio (ARCHITECTURE.md §5.9).
 *
 * §5.9 has said "LLM-generated suggested title/description/hashtags,
 * schema-validated" since it was written, and RENDER has been passing
 * `script.hook.slice(0, 100)`, `script.body.slice(0, 500)` and — the part
 * that gave the game away — `suggestedTags: []`. Every export ever produced
 * has carried a title that is the first sentence of the narration, a
 * description that is the narration cut off mid-word ("What if they get"),
 * and no tags at all. Nothing surfaced it, because nothing rendered the
 * tags until stage 6's metadata sheet.
 *
 * One model call, and it is allowed to fail. That is the same contract
 * PLAN, EDIT and RESEARCH have and for the same reason: this is the last
 * stage before EXPORT, and a finished video that reaches the operator with
 * a mechanical title is worth incomparably more than no video. The
 * heuristic below is what a failure degrades to, and it is a real fallback
 * rather than a slice — a whole-sentence title, a description that ends
 * where a sentence ends, and hashtags off the script's own keywords.
 */

/** YouTube's hard ceiling for a title is 100 characters; a Short that gets truncated in the feed reads as sloppy well before that. */
const MAX_TITLE_CHARS = 100;
/** Room for a real description without pushing the request's token cost up for text nobody reads past the fold. */
const MAX_DESCRIPTION_CHARS = 900;
const MAX_HASHTAGS = 8;

/**
 * Completion budget for the listing call.
 *
 * **Raised from 1,024 on 2026-09-04, because 1,024 was silently costing the
 * operator every listing this file was written to produce.** The output is a
 * title, a paragraph and a word list — a few hundred tokens — so 1,024
 * looked generous. It is not, for exactly the reason `JSON_MAX_TOKENS`
 * records in `request-json.ts`: the gpt-oss models spend reasoning tokens
 * before they emit anything, and those count against the same ceiling.
 * Measured against `GROQ_LIGHT_MODEL` with a real 160-word narration on
 * 2026-09-04, one draft came back at 1,571 output tokens.
 *
 * The failure is quiet by construction. Groq's JSON mode validates the
 * generation server-side, so a completion truncated at the ceiling comes
 * back as HTTP 400 `json_validate_failed` rather than as short JSON — and
 * `generateUploadMetadata` has no repair retry, because it fails soft. So a
 * request one token too small does not error: it returns
 * `heuristicUploadMetadata` with a plausible `degradedReason`, and the
 * operator gets the mechanical title this whole file exists to replace.
 * That is what the 2026-09-04 run's `json_validate_failed` on 581 in /
 * 1,024 out was.
 *
 * 3,072 for the same reason `request-json.ts` picks it, and not more: the
 * Groq limiter prices a request at `maxTokens + promptChars / 4` against an
 * 8,000-token/minute bucket, and a single call that can consume the whole
 * bucket makes `acquire()` wait for a refill that never comes.
 */
const METADATA_MAX_TOKENS = 3072;

const MetadataSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  hashtags: z.array(z.string().min(1)),
});

export interface UploadMetadata {
  title: string;
  description: string;
  /** Bare words, no leading `#`. The console adds it — a stored `#` would double up the moment anything else formats them. */
  hashtags: string[];
  /** Null when the model wrote them. Set when this is the heuristic fallback, and says why. */
  degradedReason: string | null;
}

export interface UploadMetadataSource {
  hook: string;
  body: string;
  debateQuestion: string;
  /** The operator's topic for this render, when there was one — it is the single best hashtag and the model should not have to infer it. */
  topic: string | null;
}

/** `#` is added at the point of display; here they are bare, lowercase-preserving words with nothing YouTube would strip. */
function cleanHashtag(raw: string): string {
  return raw
    .replace(/^#+/, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 30);
}

function dedupe(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const key = tag.toLowerCase();
    if (tag.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/**
 * Cuts at a sentence boundary, or failing that a word boundary — never
 * mid-word.
 *
 * `.slice(0, 500)` is what produced `"...What if they get"` on a live
 * export. A description that stops mid-sentence is not a shorter
 * description, it is a broken one, and it is the first thing a viewer sees
 * under the video.
 */
export function trimToSentence(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const window = trimmed.slice(0, maxChars);
  const lastSentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "));
  // Only if the sentence cut keeps most of the budget. Without a floor, a
  // 900-character description whose one early sentence ended at character 30
  // would come out thirty characters long.
  if (lastSentence > maxChars * 0.4) return window.slice(0, lastSentence + 1);
  const lastSpace = window.lastIndexOf(" ");
  return `${(lastSpace > 0 ? window.slice(0, lastSpace) : window).replace(/[,;:\s]+$/, "")}…`;
}

/**
 * What EXPORT uses when the model call fails, or is never made.
 *
 * Deterministic, free, and derived only from the script — the same
 * `extractKeywords` heuristic stage 6 already uses to pick preview stills,
 * so the hashtags describe the same thing the shards do.
 */
export function heuristicUploadMetadata(source: UploadMetadataSource, degradedReason: string): UploadMetadata {
  const keywords = extractKeywords({ hook: source.hook, body: source.body, debateQuestion: source.debateQuestion }, MAX_HASHTAGS);
  const question = source.debateQuestion.trim();
  return {
    title: trimToSentence(source.hook, MAX_TITLE_CHARS),
    // Hook, then the question it leaves the viewer with — which is what the
    // format is for, and reads as a description rather than as a transcript.
    description: trimToSentence(question.length > 0 ? `${source.hook.trim()}\n\n${question}` : source.body, MAX_DESCRIPTION_CHARS),
    hashtags: dedupe([...(source.topic === null ? [] : [cleanHashtag(source.topic)]), ...keywords.map(cleanHashtag)].filter((tag) => tag.length > 1)).slice(0, MAX_HASHTAGS),
    degradedReason,
  };
}

function buildPrompt(source: UploadMetadataSource): string {
  return `You are writing the YouTube listing for a finished short-form video. You are NOT writing the video.

<narration>
${source.body}
</narration>

<hook>${source.hook}</hook>
<closing_question>${source.debateQuestion}</closing_question>
${source.topic === null ? "" : `<topic>${source.topic}</topic>`}

Write:
- title: at most ${MAX_TITLE_CHARS} characters, a complete phrase, no quotation marks, no clickbait ellipses. It should make someone want to argue.
- description: 2-4 sentences about what the video argues, then the closing question on its own line. Do not transcribe the narration. At most ${MAX_DESCRIPTION_CHARS} characters.
- hashtags: ${MAX_HASHTAGS} or fewer, single words or joined words, NO "#" prefix, specific to this video's subject. Avoid generic filler like "viral" or "fyp".

Output JSON only, as: {"title": "...", "description": "...", "hashtags": ["...", "..."]}`;
}

/**
 * Writes the listing, and never fails.
 *
 * The `Result` type is deliberately absent from the return: there is no
 * caller for whom "no metadata" is a better outcome than "heuristic
 * metadata", and returning an error would only push this same fallback into
 * EXPORT. The reason travels on `degradedReason` and reaches the audit
 * package, so a reviewer looking at a mechanical title knows it is a
 * mechanical title.
 */
export async function generateUploadMetadata(llm: LlmDriver, source: UploadMetadataSource): Promise<UploadMetadata> {
  const completion = await llm.complete({
    model: GROQ_LIGHT_MODEL,
    messages: [{ role: "system", content: buildPrompt(source) }],
    jsonSchema: true,
    maxTokens: METADATA_MAX_TOKENS,
    temperature: 0.7,
  });

  if (!completion.ok) return heuristicUploadMetadata(source, describeFailure(completion.error));

  let parsed: unknown;
  try {
    parsed = JSON.parse(completion.value.content);
  } catch {
    return heuristicUploadMetadata(source, "the model's listing was not JSON");
  }

  const validated = MetadataSchema.safeParse(parsed);
  if (!validated.success) return heuristicUploadMetadata(source, "the model's listing did not match the expected shape");

  const hashtags = dedupe(validated.data.hashtags.map(cleanHashtag).filter((tag) => tag.length > 1)).slice(0, MAX_HASHTAGS);
  // A listing with a title but no usable hashtags is half an answer, and the
  // half that is missing is the one the operator asked for. The script's own
  // keywords fill it rather than the field going out empty.
  const fallbackTags = heuristicUploadMetadata(source, "unused").hashtags;

  return {
    title: trimToSentence(validated.data.title, MAX_TITLE_CHARS),
    description: trimToSentence(validated.data.description, MAX_DESCRIPTION_CHARS),
    hashtags: hashtags.length > 0 ? hashtags : fallbackTags,
    degradedReason: null,
  };
}

function describeFailure(error: DriverError): string {
  return `the listing was written from the script instead: ${error.kind}: ${error.message.slice(0, 200)}`;
}
