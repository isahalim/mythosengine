/**
 * Stage 6 — review and past work (board 3).
 *
 * "final video is done rendering and downloadable with no cracks", then
 * "user can repeat the process and the stages happen again one by one."
 *
 * The pane for a finished video is whole — no cracks, which is the visual
 * promise the forge was making — and since 2026-09-03 (operator direction)
 * it is the landing demo's `ShardPlayer`, so a finished video is presented
 * the same way everywhere on this site: an unbroken window, then the
 * fragments with the keyword stills behind them, then the Short playing in
 * place. It streams from `/console/exports/:id/stream`, deliberately not
 * the download route — watching a video in the console is not taking
 * possession of it, and a queue that marks an export downloaded because
 * someone watched ten seconds of it has stopped telling the truth.
 *
 * Operator direction (2026-08-31): no white cards. A finished video is the
 * same thing here it has been since stage 2 — its glass, floating — so the
 * panel behind it is gone and the fragments carry the whole shape. They
 * also stop being empty: each one masks a Pexels still drawn from that
 * video's own script keywords, so the shards read as a sneak peek of what
 * the video argues rather than as decoration.
 *
 * Operator direction (2026-09-01): those stills are behind the glass, not
 * printed on it. This grid used to pass `reveal="always"` and every
 * fragment of every card showed its still at once, which left three walls
 * of thumbnails where three pieces of cracked glass should be. The pane now
 * behaves here exactly as it does in stage 5 — plain glass until the cursor
 * is on a single fragment, which then fades its still up slowly.
 *
 * Those stills are PREVIEWS. The rendered footage comes from the
 * maintained, provenance-tracked library and never from Pexels (CLAUDE.md);
 * the caption below says so and the attribution stays visible.
 *
 * A grid rather than stage 5's ring: this is the whole library of past
 * work, and a ring of six positions stops being a layout at the seventh
 * video. Each entry still drifts on its own phase, so nothing about it
 * reads as a table of rows.
 *
 * CLAUDE.md, twice over: an export is never offered without its audit
 * context, and there is no publish path here — no upload button exists in
 * this system by design, and the copy says so.
 */
import { Fragment, useCallback, useEffect, useState, type CSSProperties } from "react";
import {
  describeError,
  discardExport,
  downloadExportUrl,
  isUnauthorized,
  listExportPreviews,
  listExports,
  markExportReviewed,
  streamExportUrl,
} from "../api.ts";
import { ShardPlayer } from "../glass/ShardPlayer.tsx";
import { MetadataPanel } from "./MetadataPanel.tsx";
import type { ExportListItem, MontageClip } from "../types.ts";
import { Button } from "../ui/Button.tsx";
import { StageFrame } from "../ui/StageFrame.tsx";

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** Drift character per position — stable, and never the same period twice in a row. */
function driftStyle(i: number): CSSProperties {
  return {
    "--float-dur": `${13 + (i % 4) * 1.9}s`,
    "--float-delay": `${-(i % 5) * 2.1}s`,
    "--float-x": `${7 + (i % 3) * 4}px`,
    "--float-y": `${9 + (i % 4) * 3}px`,
    "--float-rot": `${0.7 + (i % 3) * 0.35}deg`,
  } as CSSProperties;
}

interface Stage6Props {
  onRestart: () => void;
  onUnauthorized: () => void;
}

export function Stage6Review({ onRestart, onUnauthorized }: Stage6Props) {
  const [items, setItems] = useState<ExportListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Distinct from `items !== null`: a failed read leaves items null but is
  // NOT still loading, and the queue used to go on saying "Reading the
  // export queue…" underneath its own error message.
  const [settled, setSettled] = useState(false);
  const [clipsByExport, setClipsByExport] = useState<Record<string, MontageClip[]>>({});
  // One open sheet at a time. It is a long panel and two of them side by
  // side in a three-column grid reads as noise rather than as two answers.
  const [metadataFor, setMetadataFor] = useState<string | null>(null);
  const [previewNote, setPreviewNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const result = await listExports();
    setSettled(true);
    if (!result.ok) {
      if (isUnauthorized(result.error)) {
        onUnauthorized();
        return;
      }
      setError(describeError(result.error));
      return;
    }
    setError(null);
    setItems(result.value);
  }, [onUnauthorized]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * The sneak peeks, fetched once. Deliberately not folded into `refresh`:
   * that runs again after every mark-reviewed and discard, and this reaches
   * Pexels — re-requesting a set of stills because a status column changed
   * would spend the free tier on nothing.
   *
   * A failure here is stated, never hidden. Empty shards with no
   * explanation would read as a broken render rather than as a missing key.
   */
  useEffect(() => {
    let cancelled = false;
    void listExportPreviews().then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        if (isUnauthorized(result.error)) return;
        setPreviewNote("Preview stills are unavailable — the shards show the videos without them.");
        return;
      }
      if (!result.value.configured) {
        setPreviewNote("No Pexels key is configured, so there are no preview stills to show.");
        return;
      }
      const next: Record<string, MontageClip[]> = {};
      for (const row of result.value.exports) next[row.exportId] = row.clips;
      setClipsByExport(next);
      if (result.value.failures.length > 0) {
        setPreviewNote(`${result.value.failures.length} keyword${result.value.failures.length === 1 ? "" : "s"} returned no preview stills.`);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const act = async (id: string, fn: (id: string) => Promise<{ ok: boolean }>): Promise<void> => {
    setBusyId(id);
    const result = await fn(id);
    setBusyId(null);
    if (!result.ok) {
      setError("That action did not go through — nothing was changed.");
      return;
    }
    await refresh();
  };

  const live = (items ?? []).filter((e) => e.status !== "discarded" && e.status !== "expired");

  return (
    <StageFrame
      eyebrow="Step 5 of 5"
      title="Finished, and waiting on you"
      blurb="Nothing here has been published. This system holds no upload credential — you download, you watch, you decide."
      footer={
        <Button variant="primary" onClick={onRestart}>
          Run it again →
        </Button>
      }
    >
      {/* pointer-events-auto: StageFrame's content box is transparent so the
          border fragments stay reachable, and a scroll container has to take
          the wheel back. Scoped to the column the entries occupy.

          **pt-14 is a clearance buffer, not a margin** (operator direction,
          2026-09-03). A card paints well above its own layout box, and
          `StageFrame`'s 24px gap was never enough for it: the glass was
          overlapping the stage's heading at rest and cutting through it once
          opened. Measured at 1440x900, as the distance the topmost painted
          glass rises above the grid's top edge:

            sealed, drifting   18px   (float-drift, up to --float-y)
            sealed, hovered    28px   (+ the slab's scale 1.035 / tz 40px)
            cracked            46px   (+ SPREAD.cracked pushes the top
                                       fragments 13% of the pane upward)
            open               60px   (+ SPREAD.open, 16% and tz 44px)

          — which left the header with +6px of clearance at rest and **-36px**
          with a card open. 56px covers the worst of those with ~20px to
          spare, which is also where the `.shard--hot` halo lives (a 34px
          blur that `getBoundingClientRect` does not report). It scrolls away
          with the content, as it should: this buys the resting view, not a
          permanent no-go zone. */}
      <div className="pointer-events-auto h-full overflow-y-auto pt-14">
        {error !== null && (
          <p className="resolve-in mb-3 rounded-xl border border-rose/25 bg-rose/5 px-4 py-2 font-mono text-xs text-rose">{error}</p>
        )}

        {!settled && <p className="py-10 text-center font-mono text-xs text-bone">Reading the export queue…</p>}

        {settled && items !== null && live.length === 0 && (
          <p className="py-10 text-center font-mono text-xs text-bone">No exports are waiting. Run the pipeline and they will land here.</p>
        )}

        {/* `grid-flow-row-dense`: the open metadata sheet is a full-width
            grid item, and a full-span item always starts a new row — so
            without dense packing, opening it shoved the two cards beside it
            down below the sheet. Dense backfills the holes it left, so the
            row the operator is looking at stays exactly as it was and the
            sheet opens underneath it. The cost is that DOM order and visual
            order diverge for the cards after the sheet (they are read after
            it, and drawn before it); the sheet belongs to the card above it
            and carries its own Close, so that is the cheaper of the two. */}
        <div className="grid grid-cols-1 gap-x-6 gap-y-8 grid-flow-row-dense sm:grid-cols-2 lg:grid-cols-3">
          {live.map((item, i) => (
            // No card. The fragments are the shape, and the only thing
            // defining this entry's edge is where its glass stops.
            //
            // **The sheet is its own grid item, spanning the row** (operator
            // direction, 2026-09-03). It used to open by making this
            // `<article>` span all three columns, which widened the entry —
            // and the glass with it, since the pane is a fraction of its
            // container. Clicking Metadata resized the video the operator
            // was watching. The sheet still needs the full width (its
            // footage table is wider than a third of the grid, and a table
            // scrolled sideways to read a timestamp is not an answer), so it
            // takes the row on its own, immediately below, and every card
            // keeps exactly the size it had.
            <Fragment key={item.id}>
              <article className="resolve-in flex flex-col gap-3" style={{ animationDelay: `${100 + i * 80}ms` }}>
                {/* Whole glass, with the finished video inside it. The same
                    three states as the landing demo (operator direction,
                    2026-09-03): an unbroken window, then the fragments with
                    this video's own keyword stills behind them, then the
                    Short playing in the middle with the rim still live.

                    No per-card `variant` any more. A different sparse cut
                    per card was right when a card was a *card made of
                    shards* and three side by side had to read as three
                    panes. At rest these are unbroken windows now, and a
                    window is a window; what tells them apart is the video
                    in it, which is what the operator came for. */}
                <div className="float-group float-group--inline mx-auto w-2/3" style={driftStyle(i)}>
                  <ShardPlayer
                    src={streamExportUrl(item.id)}
                    revealUrl={(index) => {
                      const clips = clipsByExport[item.id] ?? [];
                      // Stable for the life of the card: fragment i always
                      // holds the same still, so uncovering the same piece
                      // twice shows the same thing.
                      return clips.length === 0 ? null : clips[index % clips.length].thumbnailUrl;
                    }}
                    keepReveals
                    hoverLift={46}
                    missingLabel="This export's bytes are gone — it may have expired."
                  />
                </div>

                <div>
                  <p className="font-mono text-[0.6rem] uppercase tracking-[0.2em] text-bone">
                    {item.status.replace(/_/g, " ")} · {megabytes(item.sizeBytes)}
                    {item.durationS !== null && ` · ${item.durationS.toFixed(0)}s`}
                  </p>
                  <h2 className="mt-1 font-display text-sm font-semibold leading-snug tracking-tight text-mercury">{item.suggestedTitle}</h2>
                </div>

                {/* The audit context an export must never travel without
                    (CLAUDE.md NEVER block). Each field is shown only when
                    the API actually returned it — a missing value reads as
                    missing, never as a plausible default. */}
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-hairline pt-3 font-mono text-[0.65rem] text-bone">
                  <dt>hook</dt>
                  <dd className="truncate text-mercury">{item.scriptHook ?? "— not reported"}</dd>
                  <dt>footage</dt>
                  <dd className="truncate text-mercury">{item.footageGame ?? "— not reported"}</dd>
                  <dt>voice</dt>
                  <dd className="truncate text-mercury">{item.ttsVoice ?? "— not reported"}</dd>
                  <dt>expires</dt>
                  <dd className="truncate text-mercury">{item.expiresAt}</dd>
                </dl>

                {item.containsSyntheticMedia && (
                  <p className="rounded-lg bg-sodium/8 px-2.5 py-1.5 font-mono text-[0.62rem] text-sodium">
                    Contains synthetic media — disclose this when you upload.
                  </p>
                )}

                <div className="mt-auto flex flex-wrap gap-2 pt-1">
                  {/* A plain link, never a fetch: the route answers video/mp4
                      with a Content-Disposition attachment, and a fetch would
                      buffer the whole file just to hand it back to the browser. */}
                  <a className="btn btn--primary px-4 py-2 text-xs" href={downloadExportUrl(item.id)}>
                    Download
                  </a>
                  <Button
                    className="!px-4 !py-2 !text-xs"
                    disabled={busyId === item.id || item.status === "reviewed"}
                    onClick={() => void act(item.id, markExportReviewed)}
                  >
                    {item.status === "reviewed" ? "Reviewed" : "Mark reviewed"}
                  </Button>
                  {/* The audit package has always carried this; nothing put
                      it on screen. Without it "which YouTube videos are in
                      this video" was answerable only from a CI log. */}
                  <Button
                    className="!px-4 !py-2 !text-xs"
                    onClick={() => setMetadataFor((current) => (current === item.id ? null : item.id))}
                  >
                    {metadataFor === item.id ? "Hide metadata" : "Metadata"}
                  </Button>
                  <Button
                    variant="ghost"
                    className="!px-4 !py-2 !text-xs"
                    disabled={busyId === item.id}
                    onClick={() => void act(item.id, discardExport)}
                  >
                    Discard
                  </Button>
                </div>
              </article>

              {metadataFor === item.id && (
                <div className="col-span-full">
                  <MetadataPanel exportId={item.id} onClose={() => setMetadataFor(null)} onUnauthorized={onUnauthorized} />
                </div>
              )}
            </Fragment>
          ))}
        </div>

        {previewNote !== null && <p className="mt-6 font-mono text-[0.68rem] text-bone">{previewNote}</p>}

        {Object.keys(clipsByExport).length > 0 && (
          // CLAUDE.md: footage provenance is never implied. These stills
          // are a preview of the script's keywords, not the footage in the
          // video, and the UI has to keep saying so.
          <p className="mt-6 text-[0.65rem] leading-relaxed text-bone">
            Click a pane to crack it open, then hover a shard to reveal a preview still from Pexels for that script&apos;s keywords. They are not
            the rendered footage — that comes from the maintained, provenance-tracked library and never from here. Click again to play the
            finished Short in place; watching it here never marks it downloaded.
          </p>
        )}
      </div>
    </StageFrame>
  );
}
