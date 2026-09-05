import { describe, expect, it } from "vitest";
import { MAX_ATTACHMENT_CHARS, MAX_TOTAL_ATTACHMENT_CHARS, readAttachments, type AttachmentBytes, type VisualReader } from "./brief-attachments.ts";

function textFile(filename: string, body: string, mimeType = "text/plain"): AttachmentBytes {
  return { filename, mimeType, bytes: new TextEncoder().encode(body) as Uint8Array<ArrayBuffer> };
}

function imageFile(filename = "shot.png"): AttachmentBytes {
  return { filename, mimeType: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) as Uint8Array<ArrayBuffer> };
}

const describing: VisualReader = { describe: () => Promise.resolve("a chart of subscriber counts") };

describe("readAttachments", () => {
  it("decodes text directly, with no model involved", async () => {
    const result = await readAttachments([textFile("notes.txt", "the letter had 400 signatories")], null);

    expect(result.text).toContain("[notes.txt]");
    expect(result.text).toContain("400 signatories");
    expect(result.unreadable).toEqual([]);
  });

  it("sends an image through the visual reader", async () => {
    const result = await readAttachments([imageFile()], describing);

    expect(result.text).toContain("a chart of subscriber counts");
    expect(result.unreadable).toEqual([]);
  });

  it("reports an image it cannot read rather than failing, and keeps going", async () => {
    const files = [imageFile("broken.png"), textFile("notes.txt", "still here")];
    const result = await readAttachments(files, null);

    expect(result.unreadable).toEqual([{ filename: "broken.png", reason: "GEMINI_API_KEY is not set, so this file could not be read" }]);
    expect(result.text).toContain("[broken.png] could not be read.");
    // The whole point: one bad file costs its own content and nothing else.
    expect(result.text).toContain("still here");
  });

  it("survives a visual reader that throws", async () => {
    const throwing: VisualReader = { describe: () => Promise.reject(new Error("429 quota")) };
    const result = await readAttachments([imageFile()], throwing);

    expect(result.unreadable[0].reason).toContain("429 quota");
    expect(result.text).toContain("could not be read");
  });

  it("reports invalid UTF-8 rather than emitting replacement characters", async () => {
    const invalid: AttachmentBytes = { filename: "bad.txt", mimeType: "text/plain", bytes: new Uint8Array([0xff, 0xfe, 0xfd]) as Uint8Array<ArrayBuffer> };
    const result = await readAttachments([invalid], null);

    expect(result.unreadable[0].reason).toContain("not valid UTF-8");
  });

  it("refuses a type nothing can read, naming it", async () => {
    const zip: AttachmentBytes = { filename: "a.zip", mimeType: "application/zip", bytes: new Uint8Array([1]) as Uint8Array<ArrayBuffer> };
    const result = await readAttachments([zip], describing);

    expect(result.unreadable[0].reason).toBe("unsupported type application/zip");
  });

  it("truncates one oversized file at the per-file cap and says so", async () => {
    const result = await readAttachments([textFile("big.txt", "x".repeat(MAX_ATTACHMENT_CHARS + 500))], null);

    expect(result.text).toContain("truncated at");
    expect(result.text.length).toBeLessThan(MAX_ATTACHMENT_CHARS + 200);
  });

  it("stops spending the shared budget rather than letting five files crowd out the prompt", async () => {
    const big = () => textFile("f.txt", "y".repeat(MAX_ATTACHMENT_CHARS));
    const files = [big(), big(), big(), big(), big()];

    const result = await readAttachments(files, null);

    expect(result.text.length).toBeLessThanOrEqual(MAX_TOTAL_ATTACHMENT_CHARS + 500);
    // The files that did not fit are named, not dropped in silence.
    expect(result.unreadable.some((f) => f.reason.includes("budget"))).toBe(true);
  });
});
