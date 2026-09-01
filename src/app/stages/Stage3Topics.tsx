/**
 * Stage 3 — topics (board 2).
 *
 * Operator direction (2026-08-31): no cards. The shards lit in stage 2
 * keep floating around the centre; hovering one tilts it, clicking one
 * opens the radial topic ring for that video.
 *
 * Board 2: "each gets fused with another piece of glass shard, where that
 * new piece can be hovered over to choose topic ... = an associated color
 * for the new added shard." The fused piece takes the hue; the fragment
 * the operator lit keeps its rainbow, because it is the video's identity
 * rather than its subject.
 */
import { useState } from "react";
import { FloatingField, FloatingGroup, ringPositions } from "../glass/FloatingField.tsx";
import { videoShards } from "../glass/videoGlass.ts";
import { isAgentChoice, topicBlurb, topicColor, topicHalo, topicLabel, topicWash, TOPIC_CHOICES, type TopicChoice } from "../topics.ts";
import type { VideoSpec } from "../state.ts";
import { Button } from "../ui/Button.tsx";
import { RadialDial, type DialItem } from "../ui/RadialDial.tsx";
import { StageFrame } from "../ui/StageFrame.tsx";

const DIAL_ITEMS: DialItem[] = TOPIC_CHOICES.map((choice) => ({
  id: choice,
  label: topicLabel(choice),
  detail: topicBlurb(choice),
  hue: topicColor(choice),
  rainbow: isAgentChoice(choice),
}));

interface Stage3Props {
  videos: VideoSpec[];
  onSetTopic: (slot: number, topic: TopicChoice) => void;
  onConfirm: () => void;
  complete: boolean;
}

export function Stage3Topics({ videos, onSetTopic, onConfirm, complete }: Stage3Props) {
  const [open, setOpen] = useState<number | null>(null);
  const openVideo = videos.find((v) => v.slot === open) ?? null;
  const positions = ringPositions(videos.length);

  const glassFor = (video: VideoSpec) =>
    videoShards({
      slot: video.slot,
      topicWash: video.topic === null || isAgentChoice(video.topic) ? null : topicWash(video.topic),
      topicHalo: video.topic === null ? null : topicHalo(video.topic),
      withFuse: true,
      withIdea: false,
    });

  return (
    <StageFrame
      eyebrow="Step 2 of 5"
      title="What should each one argue about?"
      blurb="Each lit shard has fused with a new piece. Open one and choose from the ring — the colour you pick is the colour that new piece keeps."
      footer={
        <>
          <span className="font-mono text-xs text-bone">
            {videos.filter((v) => v.topic !== null).length} / {videos.length} chosen
          </span>
          <Button variant="primary" disabled={!complete} onClick={onConfirm}>
            Find stories →
          </Button>
        </>
      }
    >
      <FloatingField>
        {videos.map((video, i) => (
          <FloatingGroup
            key={video.slot}
            seed={video.slot + 1}
            box={positions[i]}
            shards={glassFor(video)}
            onClick={() => setOpen(video.slot)}
            label={`Video ${i + 1} — ${video.topic === null ? "choose a topic" : topicLabel(video.topic)}`}
            caption={
              <>
                <p className="font-mono text-[0.58rem] uppercase tracking-[0.2em] text-bone">Video {i + 1}</p>
                <p className="font-display text-xs font-semibold tracking-tight text-mercury">
                  {video.topic === null ? "Choose a topic" : topicLabel(video.topic)}
                </p>
              </>
            }
          />
        ))}
      </FloatingField>

      {openVideo !== null && (
        <RadialDial
          items={DIAL_ITEMS}
          hint="Move across a topic to see what it covers."
          center={
            <FloatingGroup
              seed={openVideo.slot + 1}
              box={{ x: 0, y: 0, w: 100, h: 100 }}
              shards={glassFor(openVideo)}
            />
          }
          onPick={(id) => {
            onSetTopic(openVideo.slot, id as TopicChoice);
            setOpen(null);
          }}
          onDismiss={() => setOpen(null)}
        />
      )}
    </StageFrame>
  );
}
