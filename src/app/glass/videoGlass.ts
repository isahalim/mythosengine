/**
 * Which fragments a video is made of, and how they accumulate.
 *
 * A video's glass grows across the stages and never changes underneath
 * the operator:
 *
 *   stage 2   base                    the fragment they lit
 *   stage 3   base + fuse             fuse carries the topic's colour
 *   stage 4   base + fuse + idea      idea is larger, and sits behind
 *   stage 5   the whole set, arranged as a cracked card
 *
 * Board 2: "each gets fused with another piece of glass shard ... = an
 * associated color for the new added shard." The base fragment is the
 * video's identity and keeps its prism rainbow throughout; only the
 * pieces that join it afterwards carry a hue.
 */
import type { GroupShard } from "./FloatingField.tsx";

/** The six fragments the operator can light in stage 2, in the order they are offered. */
export const BASE_PIECES = ["desktop-05a", "desktop-06b", "desktop-03b", "desktop-07b", "desktop-02a", "desktop-06a"];
/** The partner each one fuses with in stage 3. */
const FUSE_PIECES = ["desktop-02c", "desktop-03b", "desktop-06b", "desktop-05a", "desktop-07b", "desktop-01b"];
/** The larger piece the story adds in stage 4. */
const IDEA_PIECES = ["desktop-03a", "desktop-04b", "desktop-05b", "desktop-06a", "desktop-02b", "desktop-03c"];

export const MAX_VIDEOS = BASE_PIECES.length;

export interface GlassSpec {
  slot: number;
  /** Wash + halo for the fused fragment; null leaves it on the prism rainbow. */
  topicWash: string | null;
  topicHalo: string | null;
  /** Present once a story has been chosen. */
  ideaWash?: string | null;
  ideaHalo?: string | null;
  withFuse: boolean;
  withIdea: boolean;
}

/** The fragments for one video, in draw order. */
export function videoShards({ slot, topicWash, topicHalo, ideaWash, ideaHalo, withFuse, withIdea }: GlassSpec): GroupShard[] {
  const i = slot % MAX_VIDEOS;
  const shards: GroupShard[] = [];

  if (withIdea) {
    shards.push({
      key: `s${slot}-idea`,
      pieceId: IDEA_PIECES[i],
      setKey: "desktop",
      x: -8,
      y: 24,
      w: 100,
      h: 72,
      ring: 2,
      z: 8,
      lit: ideaWash != null,
      wash: ideaWash ?? undefined,
      halo: ideaHalo ?? undefined,
    });
  }

  shards.push({
    key: `s${slot}-base`,
    pieceId: BASE_PIECES[i],
    setKey: "desktop",
    x: 4,
    y: 12,
    w: 50,
    h: 64,
    ring: 1,
    z: 12,
    lit: true,
    rainbow: true,
  });

  if (withFuse) {
    shards.push({
      key: `s${slot}-fuse`,
      pieceId: FUSE_PIECES[i],
      setKey: "desktop",
      x: 40,
      y: 4,
      w: 52,
      h: 58,
      ring: 0,
      z: 14,
      lit: true,
      rainbow: topicWash === null,
      wash: topicWash ?? undefined,
      halo: topicHalo ?? undefined,
    });
  }

  return shards;
}
