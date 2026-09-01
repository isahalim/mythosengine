/**
 * Stage 2 — how many videos (board 1).
 *
 * "6 3D shards floating in the middle ... click, makes them glow rainbow
 * dispersed gradient", and "# of glows = # of videos."
 *
 * The fragment IS the input. There is no number field: the operator
 * lights as many pieces of glass as they want videos, and the count
 * follows. Each candidate floats on its own drift, and the ones that are
 * lit here are the exact fragments that carry the run through every
 * later stage.
 */
import { FloatingField, FloatingGroup, ringPositions } from "../glass/FloatingField.tsx";
import { BASE_PIECES, MAX_VIDEOS } from "../glass/videoGlass.ts";
import { Button } from "../ui/Button.tsx";
import { StageFrame } from "../ui/StageFrame.tsx";

const POSITIONS = ringPositions(MAX_VIDEOS);

interface Stage2Props {
  lit: number[];
  onToggle: (slot: number) => void;
  onConfirm: () => void;
}

export function Stage2Count({ lit, onToggle, onConfirm }: Stage2Props) {
  const count = lit.length;

  return (
    <StageFrame
      eyebrow="Step 1 of 5"
      title="How many videos?"
      blurb="Light a shard for each Short you want this run to produce. Every lit shard becomes one video, and stays that video's glass all the way to the download."
      footer={
        <>
          <span className="font-mono text-xs text-bone">{count === 0 ? "No shards lit" : `${count} ${count === 1 ? "video" : "videos"}`}</span>
          <Button variant="primary" disabled={count === 0} onClick={onConfirm}>
            Choose topics →
          </Button>
        </>
      }
    >
      <FloatingField>
        {BASE_PIECES.map((pieceId, slot) => {
          const isLit = lit.includes(slot);
          return (
            <FloatingGroup
              key={pieceId}
              seed={slot + 1}
              box={POSITIONS[slot]}
              dimmed={!isLit && count > 0}
              onClick={() => onToggle(slot)}
              label={isLit ? `Shard ${slot + 1}, lit — click to unlight` : `Shard ${slot + 1}, dark — click to light`}
              shards={[
                {
                  key: `cand-${pieceId}`,
                  pieceId,
                  setKey: "desktop",
                  x: 6,
                  y: 8,
                  w: 88,
                  h: 84,
                  ring: slot % 3,
                  z: 12,
                  lit: isLit,
                  rainbow: isLit,
                },
              ]}
            />
          );
        })}
      </FloatingField>
    </StageFrame>
  );
}
