/**
 * The upload sheet for one finished video (operator direction, 2026-09-02).
 *
 * Stage 6 already answered "is it done, and can I download it". It could
 * not answer the two questions that actually stand between a finished file
 * and a published one: *what do I type into the YouTube description box*,
 * and *whose footage is in this*. The second one had no answer anywhere in
 * the product — the audit package has carried footage provenance since §9
 * was written, and nothing rendered it, so "did this run use any YouTube
 * videos?" was a question the operator could only answer by reading a
 * GitHub Actions log.
 *
 * So: title, description and hashtags ready to copy, and every clip in the
 * finished video with the source it came from, the span of that source it
 * used, and a link that opens the source at that second.
 *
 * The two time spans stay visually separate and separately labelled. They
 * are different facts — where the shot sits in the short, and which part of
 * the source it is — and a reviewer checking provenance needs the second
 * one, which is the one that has never been on screen before.
 *
 * CLAUDE.md, again: nothing here publishes. It is a sheet to copy from into
 * YouTube Studio by hand, and there is no upload button because this system
 * holds no upload credential.
 */
import { useEffect, useState } from "react";
import { describeError, getExportMetadata, isUnauthorized } from "../api.ts";
import type { ExportClipUse, ExportMetadata } from "../types.ts";
import { Button } from "../ui/Button.tsx";

function timecode(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** The source span, or an honest blank. Never "0:00–0:00" for a record that simply does not carry it. */
function sourceSpan(clip: ExportClipUse): string {
  if (clip.sourceStartS === null || clip.sourceEndS === null) return "— not recorded";
  return `${timecode(clip.sourceStartS)}–${timecode(clip.sourceEndS)}`;
}

function CopyButton({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      className="!px-2.5 !py-1 !text-[0.6rem]"
      onClick={() => {
        // Best effort, and it says which it was. `navigator.clipboard` is
        // unavailable on an insecure origin and can be refused outright, and
        // a button that silently did nothing would be worse than one that
        // says it could not.
        void navigator.clipboard
          ?.writeText(value)
          .then(() => setCopied(true))
          .catch(() => setCopied(false));
      }}
    >
      {copied ? "copied" : label}
    </Button>
  );
}

interface MetadataPanelProps {
  exportId: string;
  onClose: () => void;
  onUnauthorized: () => void;
}

export function MetadataPanel({ exportId, onClose, onUnauthorized }: MetadataPanelProps) {
  const [data, setData] = useState<ExportMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getExportMetadata(exportId).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        if (isUnauthorized(result.error)) {
          onUnauthorized();
          return;
        }
        setError(describeError(result.error));
        return;
      }
      setData(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, [exportId, onUnauthorized]);

  const youtubeClips = (data?.clips ?? []).filter((clip) => clip.provider === "youtube");

  return (
    <div className="resolve-in mt-1 rounded-xl border border-hairline bg-ink/40 p-3 backdrop-blur-sm">
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-mono text-[0.6rem] uppercase tracking-[0.2em] text-bone">metadata</p>
        <Button variant="ghost" className="!px-2.5 !py-1 !text-[0.6rem]" onClick={onClose}>
          close
        </Button>
      </div>

      {error !== null && <p className="mt-2 font-mono text-[0.65rem] text-rose">{error}</p>}
      {error === null && data === null && <p className="mt-2 font-mono text-[0.65rem] text-bone">Reading the audit package…</p>}

      {data !== null && (
        <div className="mt-3 flex flex-col gap-4">
          <section className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <p className="font-mono text-[0.6rem] uppercase tracking-[0.18em] text-bone">title</p>
              <CopyButton label="copy" value={data.suggestedTitle} />
            </div>
            <p className="text-xs leading-snug text-mercury">{data.suggestedTitle}</p>
          </section>

          <section className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <p className="font-mono text-[0.6rem] uppercase tracking-[0.18em] text-bone">description</p>
              <CopyButton label="copy" value={data.suggestedDescription} />
            </div>
            <p className="whitespace-pre-wrap text-[0.7rem] leading-relaxed text-mercury">{data.suggestedDescription}</p>
          </section>

          <section className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <p className="font-mono text-[0.6rem] uppercase tracking-[0.18em] text-bone">hashtags</p>
              {data.hashtags.length > 0 && <CopyButton label="copy" value={data.hashtags.join(" ")} />}
            </div>
            {data.hashtags.length === 0 ? (
              <p className="font-mono text-[0.65rem] text-bone">— none were generated for this video</p>
            ) : (
              <p className="font-mono text-[0.68rem] leading-relaxed text-mercury">{data.hashtags.join(" ")}</p>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <p className="font-mono text-[0.6rem] uppercase tracking-[0.18em] text-bone">
              footage · {data.clips.length} clip{data.clips.length === 1 ? "" : "s"}
            </p>

            {/* The straight answer, first, because it is the question that
                sent the operator to a CI log. */}
            <p className={`font-mono text-[0.65rem] ${data.usedYoutube ? "text-mercury" : "text-sodium"}`}>
              {data.usedYoutube
                ? `${youtubeClips.length} of ${data.clips.length} clip${data.clips.length === 1 ? "" : "s"} came from YouTube; the rest are stock.`
                : "No YouTube footage — every clip in this video is stock."}
            </p>

            {data.clips.length === 0 ? (
              <p className="font-mono text-[0.65rem] text-bone">— this export records no per-clip footage</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[34rem] border-collapse font-mono text-[0.62rem]">
                  <thead>
                    <tr className="text-left text-bone">
                      <th className="border-b border-hairline py-1 pr-3 font-normal">#</th>
                      <th className="border-b border-hairline py-1 pr-3 font-normal">in video</th>
                      <th className="border-b border-hairline py-1 pr-3 font-normal">source</th>
                      <th className="border-b border-hairline py-1 pr-3 font-normal">span of source</th>
                      <th className="border-b border-hairline py-1 font-normal">found by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.clips.map((clip) => (
                      <tr key={clip.position} className="align-top text-mercury">
                        <td className="border-b border-hairline/50 py-1.5 pr-3">{clip.position}</td>
                        <td className="border-b border-hairline/50 py-1.5 pr-3 whitespace-nowrap">
                          {timecode(clip.outStartS)}–{timecode(clip.outEndS)}
                        </td>
                        <td className="border-b border-hairline/50 py-1.5 pr-3">
                          {clip.linkUrl === null ? (
                            <span className="text-bone">— {clip.provider ?? "unknown"}</span>
                          ) : (
                            <a className="underline decoration-hairline underline-offset-2 hover:text-oxide" href={clip.linkUrl} target="_blank" rel="noreferrer noopener">
                              {clip.provider}:{clip.providerClipId ?? "?"}
                            </a>
                          )}
                          {clip.photographer !== null && <span className="text-bone"> · {clip.photographer}</span>}
                        </td>
                        <td className="border-b border-hairline/50 py-1.5 pr-3 whitespace-nowrap">{sourceSpan(clip)}</td>
                        <td className="border-b border-hairline/50 py-1.5 text-bone">{clip.searchQuery ?? "— not recorded"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* EDIT trims inside the sourced window, so the span above is
                where the clip was cut FROM, not necessarily the exact
                frames that survived. Said rather than left to be inferred. */}
            {data.clips.some((clip) => clip.edited === true) && (
              <p className="text-[0.62rem] leading-relaxed text-bone">
                Clips {data.clips.filter((c) => c.edited === true).map((c) => c.position).join(", ")} were trimmed or graded by EDIT inside the span shown,
                so the source window is where the clip was taken from rather than the exact surviving frames.
              </p>
            )}
          </section>

          <section className="flex flex-col gap-1 border-t border-hairline pt-3">
            <p className="font-mono text-[0.6rem] uppercase tracking-[0.18em] text-bone">narration</p>
            <p className="font-mono text-[0.65rem] text-mercury">
              {data.narrationVoice ?? "— not recorded"} on {data.narrationDriver ?? "— not recorded"}
              {data.captionTiming !== null && ` · captions ${data.captionTiming}`}
            </p>
            {data.narrationFallbackReason !== null && <p className="font-mono text-[0.62rem] text-sodium">{data.narrationFallbackReason}</p>}
          </section>

          {(data.ungrounded || data.researchCitations.length > 0) && (
            <section className="flex flex-col gap-1 border-t border-hairline pt-3">
              <p className="font-mono text-[0.6rem] uppercase tracking-[0.18em] text-bone">grounding</p>
              {data.ungrounded ? (
                <p className="font-mono text-[0.65rem] text-sodium">RESEARCH failed — this script was written without retrieved sources.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {data.researchCitations.map((citation) => (
                    <li key={citation.url}>
                      <a className="text-[0.65rem] underline decoration-hairline underline-offset-2 text-mercury hover:text-oxide" href={citation.url} target="_blank" rel="noreferrer noopener">
                        {citation.title}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {data.incomplete.map((note) => (
            <p key={note} className="font-mono text-[0.62rem] text-bone">
              {note}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
