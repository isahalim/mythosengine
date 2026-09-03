import type { BeatMove } from "./script-schema.ts";
import { VOCABULARY } from "./delivery-tags.ts";

/**
 * The performance a single video is written and spoken to — rolled fresh
 * every render, from a seed, before SCRIPT is called.
 *
 * **Why a die and not a prompt.** Told to "vary the tone", a model varies it
 * across the space of things that model finds natural, which is a much
 * smaller space than the one the product wants. Nine renders in a row came
 * out as the same measured explainer with the same three commas. Rolling the
 * format, the tone at each phase, the sounds and the comedic device *outside*
 * the model, and handing it the result as an instruction, is the difference
 * between asking for variety and having it. It is the same reasoning that
 * put the host's action cycle in code (character-timeline.ts): where there is
 * no genuine ambiguity, spend determinism rather than tokens.
 *
 * **What is not rolled.** The energy *shape* — hook hard, warm through the
 * middle, soften at the end — holds on every video, because it is a retention
 * strategy rather than a stylistic preference: the opening has about two
 * seconds to survive a thumb, and an ending that lands quiet is what makes a
 * closing question feel like a question. So the die chooses the flavour of
 * each phase, never whether the phases exist. Operator direction, 2026-09-03.
 */
export interface PerformancePlan {
  /** What the seed was, so a run can be reproduced from the audit package alone. */
  seed: string;
  format: ScriptFormat;
  /** Opening: high energy, because the first two seconds decide whether there is a viewer. */
  opening: { tone: string; pace: string };
  /** Middle: the "vocal smile" — audibly enjoying the material, not performing at it. */
  middle: { tone: string };
  /** Close: slower and warmer, so the open question lands as a question. */
  closing: { tone: string; pace: string };
  /** Which non-verbal sounds this video may use. Laughter-weighted by design. */
  nonVerbal: string[];
  /** Roughly how many non-verbal placements to ask for, spread across the script. */
  cueTarget: number;
  /** The comedic device this script has to land at least once, delivered sarcastically. */
  comedicDevice: string;
  /** An occasional character voice for one beat, or null on most runs. */
  stylistic: string | null;
}

export interface ScriptFormat {
  id: string;
  /** One line the writer is given: what this format *is*. */
  premise: string;
  /** The arc, in the writer's terms — suggestive, never validated. */
  arc: string;
  /** The moves this shape tends to use, offered as a starting point. */
  moves: readonly BeatMove[];
}

/**
 * The shapes a script may take.
 *
 * `discourse` is first because it is what every script was until
 * 2026-09-03 — one host arguing herself out of the obvious answer — and it
 * remains a good shape, now competing on merit rather than by being the only
 * one the gate would accept. The others exist because the gate's real cost
 * was never the renders it failed; it was the scripts nobody wrote, because
 * a story or a rant could not pass a check that demanded a `pushback`
 * between an `attempt` and a `land`.
 */
export const SCRIPT_FORMATS: readonly ScriptFormat[] = [
  {
    id: "discourse",
    premise: "One mind changing its own position, out loud. She asks what the viewer is actually thinking, tries the obvious answer in good faith, catches why it is too neat, and earns a better one.",
    arc: "question -> attempt -> pushback -> reframe -> land -> open. She has to be wrong before she is right; the good-faith attempt is not a strawman.",
    moves: ["question", "attempt", "pushback", "reframe", "land", "open"],
  },
  {
    id: "story",
    premise: "A small, specific, true story from the research, told like something that happened to someone — with a turn in the middle that changes what the story was about.",
    arc: "setup -> escalation -> turn -> land -> open. The turn is the whole thing: the viewer should feel the story change genre under them.",
    moves: ["setup", "escalation", "turn", "aside", "land", "open"],
  },
  {
    id: "hot_take",
    premise: "A position, argued fast and hard, that concedes exactly once — and is more convincing for it.",
    arc: "verdict -> evidence -> escalation -> pushback (the one honest concession) -> verdict -> open.",
    moves: ["verdict", "evidence", "escalation", "pushback", "punchline", "open"],
  },
  {
    id: "myth_bust",
    premise: "The thing everyone believes about this, why it is such an appealing thing to believe, and what is actually going on.",
    arc: "setup (the myth, stated sympathetically) -> attempt -> pushback -> evidence -> reframe -> open.",
    moves: ["setup", "attempt", "pushback", "evidence", "reframe", "open"],
  },
  {
    id: "confession",
    premise: "She admits she got this wrong, or believed the easy version, and walks the viewer through what changed her mind — so the viewer gets to change theirs without being told to.",
    arc: "confession -> setup -> turn -> reframe -> land -> open.",
    moves: ["confession", "setup", "turn", "reframe", "land", "open"],
  },
  {
    id: "escalation",
    premise: "Three examples, each worse or stranger than the last, and then the thing they have in common.",
    arc: "setup -> escalation -> escalation -> escalation -> land -> open. Each step has to actually top the last one.",
    moves: ["setup", "escalation", "aside", "punchline", "land", "open"],
  },
];

/** High-energy openings. Every one of these has to survive a thumb. */
const OPENING_TONES = ["excitedly", "incredulous", "amazed", "conspiratorial", "panicked", "curious", "sarcastically"];
const OPENING_PACES = ["very fast", "very fast", "rushing", "deliberate pause"];

/** The middle: audibly enjoying it. A "vocal smile" is a real thing a listener hears. */
const MIDDLE_TONES = ["warmly", "curious", "conspiratorial", "amazed", "sarcastically", "wistful", "serious"];

/** The close: slow enough that the question lands as a question. */
const CLOSING_TONES = ["wistful", "warmly", "serious", "hushed", "reluctantly"];
const CLOSING_PACES = ["very slow", "drawn out", "deliberate pause"];

const COMEDIC_DEVICES = [
  "an old saying or proverb, quoted and then immediately undercut",
  "a joke at the expense of the obvious take",
  "a deadpan understatement about something genuinely absurd",
  "a comparison so mundane it makes the subject look ridiculous",
  "a cliché everyone uses here, said out loud until it sounds stupid",
];

/**
 * How often a video gets a character voice for one beat.
 *
 * One in four, and not more. `[like a radio DJ]` is delightful once and a bit
 * for the whole channel if it arrives every time; the tag is strong enough
 * that it should read as this video's idea, not the format's.
 */
const STYLISTIC_CHANCE = 0.25;

/** xmur3: string -> 32-bit seed. Paired with mulberry32 below; both are the standard small-PRNG pair. */
function seedFrom(text: string): () => number {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

/** `count` distinct items, or all of them when the pool is smaller. */
function pickSome<T>(rng: () => number, items: readonly T[], count: number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (out.length < count && pool.length > 0) {
    out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }
  return out;
}

/**
 * Roll one video's performance.
 *
 * Deterministic in `seed` — pass the render's trace id, and the same run
 * re-rolled during debugging produces the same performance instead of a
 * different one, which is the difference between reproducing a complaint
 * about the audio and hearing a new video.
 *
 * The laughter weighting is deliberate and is the operator's direction:
 * `giggles` and `laughs` are always in the set, and the rest of the palette
 * fills in around them. A sigh or a gasp is punctuation; a laugh is the thing
 * that makes a listener believe there is a person there.
 */
export function rollPerformance(seed: string): PerformancePlan {
  const rng = seedFrom(seed);
  const laughter = pickSome(rng, ["giggles", "laughs", "chuckles", "soft laugh"], 2);
  const colour = pickSome(rng, VOCABULARY.nonVerbal.filter((cue) => !cue.includes("laugh") && cue !== "giggles" && cue !== "chuckles"), 1 + Math.floor(rng() * 2));

  return {
    seed,
    format: pick(rng, SCRIPT_FORMATS),
    opening: { tone: pick(rng, OPENING_TONES), pace: pick(rng, OPENING_PACES) },
    middle: { tone: pick(rng, MIDDLE_TONES) },
    closing: { tone: pick(rng, CLOSING_TONES), pace: pick(rng, CLOSING_PACES) },
    nonVerbal: [...laughter, ...colour],
    cueTarget: 3 + Math.floor(rng() * 4),
    comedicDevice: pick(rng, COMEDIC_DEVICES),
    stylistic: rng() < STYLISTIC_CHANCE ? pick(rng, VOCABULARY.stylistic) : null,
  };
}

/**
 * The performance as the prompt's `{{performance}}` block.
 *
 * Written as instructions to a writer rather than as a serialized object,
 * for the same reason `formatResearchBrief` is prose: the model is being
 * asked to perform this, not to parse it.
 */
export function describePerformance(plan: PerformancePlan): string {
  const cues = plan.nonVerbal.map((cue) => `[${cue}]`).join(", ");
  const lines = [
    `FORMAT — ${plan.format.id}. ${plan.format.premise}`,
    `Suggested arc: ${plan.format.arc}`,
    `Moves this shape tends to use: ${plan.format.moves.join(", ")}. You may use any move from the schema; these are a starting point, not a rule.`,
    "",
    "DELIVERY ARC — this shape holds on every video:",
    `1. OPEN HOT. The hook and the first beat are [${plan.opening.tone}] and [${plan.opening.pace}]. You have two seconds before a thumb moves.`,
    `2. SETTLE INTO A SMILE. The middle beats run [${plan.middle.tone}] — audibly enjoying the material, talking to one person, not performing at an audience.`,
    `3. LAND SOFT. The last beat and the closing question are [${plan.closing.tone}] and [${plan.closing.pace}]. Slow enough that the question sounds like a real one.`,
    "",
    `NON-VERBAL SOUNDS — use ${cues}. Place about ${plan.cueTarget} of them across the script, not clustered at the start.`,
    "A sound goes where a real person would make it: a laugh after the absurd part, a sigh before admitting something, a gasp on the number that is genuinely shocking. Never one per beat like clockwork.",
    "",
    `COMEDY — land at least one: ${plan.comedicDevice}. Deliver that beat [sarcastically]. This is the one place sarcasm belongs; it is a spice, not the register of the whole video.`,
  ];
  if (plan.stylistic !== null) {
    lines.push("", `CHARACTER — exactly one beat, and only one, is delivered [${plan.stylistic}]. Pick the beat it is actually funny on.`);
  }
  return lines.join("\n");
}
