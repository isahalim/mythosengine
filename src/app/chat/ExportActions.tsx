import { useState } from "react";
import { describeError, discardExport, downloadExportUrl, isUnauthorized, markExportReviewed } from "../api.ts";
import type { ExportStatus } from "../types.ts";
import { Button } from "../ui/Button.tsx";

/**
 * Download · Mark reviewed · Metadata · Discard — the four things an operator
 * can do to a finished video.
 *
 * The design board names all four under the healed card on the chat route
 * ("there should be also buttons under for download, review, metadata,
 * discard"), and stage 6 has had them since it was written. Lifted here so
 * both screens run the same code: an action that behaved differently
 * depending on which route produced the video would be a genuinely confusing
 * thing to have built, and the review surface is explicitly shared between
 * the routes.
 */

interface ExportActionsProps {
  exportId: string;
  status: ExportStatus;
  /** True while this export's metadata sheet is open. The caller owns the sheet; this only reports the toggle. */
  metadataOpen: boolean;
  onToggleMetadata: () => void;
  /** Called after a successful mark-reviewed or discard, so the caller can refresh its list. */
  onChanged: () => void;
  onUnauthorized: () => void;
}

export function ExportActions({ exportId, status, metadataOpen, onToggleMetadata, onChanged, onUnauthorized }: ExportActionsProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (run: (id: string) => Promise<{ ok: true; value: unknown } | { ok: false; error: import("../../lib/drivers/types.ts").DriverError }>): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await run(exportId);
    setBusy(false);
    if (result.ok) {
      onChanged();
      return;
    }
    if (isUnauthorized(result.error)) {
      onUnauthorized();
      return;
    }
    setError(describeError(result.error));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap justify-center gap-2">
        {/* A plain link, never a fetch: the route answers video/mp4 with a
            Content-Disposition attachment, and a fetch would buffer the whole
            file just to hand it back to the browser. It is also the route
            that transitions the row to `downloaded` — which is why the player
            above uses the stream route instead, since watching a video is not
            taking possession of it. */}
        <a className="btn btn--primary px-4 py-2 text-xs" href={downloadExportUrl(exportId)}>
          Download
        </a>
        <Button className="!px-4 !py-2 !text-xs" disabled={busy || status === "reviewed"} onClick={() => void act(markExportReviewed)}>
          {status === "reviewed" ? "Reviewed" : "Review"}
        </Button>
        <Button className="!px-4 !py-2 !text-xs" onClick={onToggleMetadata}>
          {metadataOpen ? "Hide metadata" : "Metadata"}
        </Button>
        <Button variant="ghost" className="!px-4 !py-2 !text-xs" disabled={busy} onClick={() => void act(discardExport)}>
          Discard
        </Button>
      </div>
      {error !== null && <p className="text-center text-xs text-rose">{error}</p>}
    </div>
  );
}
