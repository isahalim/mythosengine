import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { HumanMessage } from "@langchain/core/messages";
import { GEMINI_REASONING_MODEL } from "../../config/models.ts";

/**
 * Turning an operator's attachments into text DIGEST can read.
 *
 * Two paths, and which one a file takes is decided by its MIME type, not by
 * a model:
 *
 * - **Text** (`text/*`, JSON) is decoded as UTF-8 and used verbatim. No model
 *   call, no cost, no failure mode beyond a truncation this file states.
 * - **Images and PDFs** go through one multimodal Gemini call that describes
 *   them. This is the only place in the chat route where an attachment can
 *   degrade, and it degrades to a line saying so — never to silence, and
 *   never to a failed brief.
 *
 * *Why the split rather than sending everything multimodally.* A CSV the
 * operator pasted in is already the text of the thing; asking a model to look
 * at it spends a request to produce a worse version of what we already hold,
 * and puts a model between the operator's own words and the stage that reads
 * them. The multimodal call exists for the files that genuinely cannot be
 * decoded, and for nothing else.
 *
 * *What a failure costs.* One attachment's content, replaced by an explicit
 * note in the digest input. The brief still renders. That is the same
 * contract RESEARCH, EDIT, CRITIC and the host overlay hold, applied to the
 * least important input in the system.
 */

/** Characters of one attachment's text that reach DIGEST. Sized so five attachments cannot crowd out the operator's own prompt. */
export const MAX_ATTACHMENT_CHARS = 8_000;

/** Total characters across all attachments. The second bound, because five files at the per-file cap would still be 40K. */
export const MAX_TOTAL_ATTACHMENT_CHARS = 24_000;

const TEXT_MIME = /^(text\/|application\/json$)/;
const VISUAL_MIME = /^(image\/(png|jpeg|webp|gif)|application\/pdf)$/;

export interface AttachmentBytes {
  filename: string;
  mimeType: string;
  bytes: Uint8Array<ArrayBuffer>;
}

export interface AttachmentReadResult {
  /** One block of text per attachment, already labelled with its filename, ready to append to the digest prompt. */
  text: string;
  /** Filenames whose content could not be read, with the reason. Reported to the operator, never swallowed. */
  unreadable: { filename: string; reason: string }[];
}

/** The seam the tests drive. Production builds the real multimodal model; a test passes its own. */
export interface VisualReader {
  describe(file: AttachmentBytes): Promise<string>;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[… truncated at ${limit} characters]`;
}

/** Base64 without Buffer, so this file stays runnable anywhere the rest of `src/lib` is. */
function toBase64(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * The real multimodal reader. One call per file, `maxRetries: 0`, on the
 * general ladder's Gemini model id — deliberately *not* `GEMINI_RESEARCH_MODEL`,
 * because the free tier meters five requests a minute per model and RESEARCH's
 * four are already spoken for.
 */
export function createVisualReader(geminiApiKey: string, timeoutMs = 60_000): VisualReader {
  const llm = new ChatGoogleGenerativeAI({ apiKey: geminiApiKey, model: GEMINI_REASONING_MODEL, temperature: 0, maxRetries: 0 });
  return {
    async describe(file) {
      const reply = await llm.invoke(
        [
          new HumanMessage({
            content: [
              {
                type: "text",
                text: "Describe what this file contains, factually and in full. If it is a document, transcribe the text. If it is an image, say what is in it. Do not interpret, argue, or summarize away detail — a later stage needs the content, not your opinion of it.",
              },
              { type: "image_url", image_url: `data:${file.mimeType};base64,${toBase64(file.bytes)}` },
            ],
          }),
        ],
        { signal: AbortSignal.timeout(timeoutMs) },
      );
      const content = reply.content;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content.map((part) => (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "")).join("");
    },
  };
}

/**
 * Reads every attachment into one labelled block of text.
 *
 * **Never throws.** A file that cannot be decoded, a multimodal call that
 * fails, an unsupported type: each becomes an entry in `unreadable` and a
 * line in the text saying that file could not be read. DIGEST then classifies
 * on what it does have, which for every brief includes the operator's own
 * prompt — the thing that actually matters.
 */
export async function readAttachments(files: AttachmentBytes[], reader: VisualReader | null): Promise<AttachmentReadResult> {
  const blocks: string[] = [];
  const unreadable: { filename: string; reason: string }[] = [];
  let budget = MAX_TOTAL_ATTACHMENT_CHARS;

  for (const file of files) {
    if (budget <= 0) {
      unreadable.push({ filename: file.filename, reason: `the ${MAX_TOTAL_ATTACHMENT_CHARS}-character attachment budget was already spent by earlier files` });
      continue;
    }

    let body: string | null = null;
    if (TEXT_MIME.test(file.mimeType)) {
      try {
        body = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
      } catch (cause) {
        unreadable.push({ filename: file.filename, reason: `not valid UTF-8 (${cause instanceof Error ? cause.message : String(cause)})` });
      }
    } else if (VISUAL_MIME.test(file.mimeType)) {
      if (reader === null) {
        unreadable.push({ filename: file.filename, reason: "GEMINI_API_KEY is not set, so this file could not be read" });
      } else {
        try {
          body = await reader.describe(file);
        } catch (cause) {
          unreadable.push({ filename: file.filename, reason: `could not be read (${cause instanceof Error ? cause.message : String(cause)})` });
        }
      }
    } else {
      unreadable.push({ filename: file.filename, reason: `unsupported type ${file.mimeType}` });
    }

    if (body === null || body.trim().length === 0) {
      blocks.push(`[${file.filename}] could not be read.`);
      continue;
    }

    const clipped = truncate(body.trim(), Math.min(MAX_ATTACHMENT_CHARS, budget));
    budget -= clipped.length;
    blocks.push(`[${file.filename}]\n${clipped}`);
  }

  return { text: blocks.join("\n\n"), unreadable };
}
