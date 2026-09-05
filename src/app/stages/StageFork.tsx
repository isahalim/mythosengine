import type { CSSProperties } from "react";
import { FloatingField, FloatingGroup } from "../glass/FloatingField.tsx";
import { videoShards } from "../glass/videoGlass.ts";
import type { Route } from "../state.ts";
import { StageFrame } from "../ui/StageFrame.tsx";

/**
 * The fork — the first thing after signing in (operator direction,
 * 2026-09-04).
 *
 * Two free-floating shards, and touching one decides which pipeline the
 * operator is in: **"Already have an idea"** goes to the chat route
 * (docs/CHAT_PIPELINE.md), **"Brainstorm first"** goes to the five stages
 * this system has always had.
 *
 * *Why it is glass rather than two buttons.* Every choice in this product is
 * made by touching a piece of glass, from lighting a fragment in stage 2 to
 * cracking the finished pane open in stage 6. A pair of rectangular buttons
 * here would be the one screen where the surface stopped being itself — and
 * it is the screen the operator sees first every session.
 *
 * *Why the two groups are built from `videoShards`.* Same reason: this is the
 * same glass, cut from the same atlas, drifting on the same spring loop as
 * every later stage. `withFuse` and `withIdea` are both on, so each side is a
 * full three-fragment group — the shape a video has by the time it reaches
 * the forge. The fork is where a video is about to begin, and it looks like
 * one.
 *
 * The right-hand group is deliberately the brainstorm one, matching the
 * board's left/right layout exactly.
 */

interface StageForkProps {
  onChoose: (route: Route) => void;
}

/** The caption under a shard. Two lines: what it is, then what it costs you. */
function Caption({ title, blurb }: { title: string; blurb: string }) {
  return (
    <>
      <p className="font-display text-sm font-medium text-mercury">{title}</p>
      <p className="mx-auto mt-1 max-w-[22rem] text-xs leading-relaxed text-bone">{blurb}</p>
    </>
  );
}

/**
 * Drift character per side — hand-set rather than derived, because there are
 * exactly two and they sit side by side. Two groups drifting on periods that
 * happen to be close read as one wobbling object; these are far enough apart
 * that they never look synchronised.
 */
const LEFT_DRIFT: CSSProperties = { "--float-dur": "14.5s", "--float-delay": "-2.4s" } as CSSProperties;
const RIGHT_DRIFT: CSSProperties = { "--float-dur": "11.2s", "--float-delay": "-6.1s" } as CSSProperties;

export function StageFork({ onChoose }: StageForkProps) {
  return (
    <StageFrame
      eyebrow="Two ways in"
      title="What are we making?"
      blurb="Bring an idea and the engine builds that. Bring nothing and it will go and find what people are arguing about right now."
    >
      <FloatingField>
        {/* `pointer-events-auto` is opt-in inside StageFrame, but the groups
            themselves already declare it (`.float-group` in shards.css) and
            FloatingGroup renders its own full-group hit target — so the
            wrapper stays transparent and the glass stays clickable. */}
        <div style={LEFT_DRIFT}>
          <FloatingGroup
            shards={videoShards({ slot: 0, topicWash: null, topicHalo: null, withFuse: true, withIdea: true })}
            box={{ x: 8, y: 8, w: 36, h: 62 }}
            seed={11}
            label="Already have an idea — describe it and the engine builds that video"
            onClick={() => onChoose("chat")}
            caption={<Caption title="Already have an idea" blurb="Type it, attach anything that helps, and the engine researches, writes, sources and cuts that video." />}
          />
        </div>

        <div style={RIGHT_DRIFT}>
          <FloatingGroup
            shards={videoShards({ slot: 3, topicWash: null, topicHalo: null, withFuse: true, withIdea: true })}
            box={{ x: 56, y: 8, w: 36, h: 62 }}
            seed={29}
            label="Brainstorm first — pick from what the feeds are arguing about today"
            onClick={() => onChoose("brainstorm")}
            caption={<Caption title="Brainstorm first" blurb="Choose how many videos, a topic each, and a story each — ranked from the discourse the engine has been watching." />}
          />
        </div>
      </FloatingField>
    </StageFrame>
  );
}
