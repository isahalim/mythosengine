/**
 * Topic identity — board 2: "new shard with specific color based on topic
 * ... or rainbow again if agent generated topic. = an associated color for
 * the new added shard."
 *
 * The hex lives in tokens.css (--topic-*); this reads it off computed
 * style so the palette has exactly one home. `AGENT` is the seventh choice
 * on the dial: let the ranker pick the topic, and the fragment keeps the
 * prism rainbow instead of taking a single hue.
 */
import { TOPICS, type Topic } from "./types.ts";

export const AGENT_CHOICE = "agent" as const;
export type TopicChoice = Topic | typeof AGENT_CHOICE;

export const TOPIC_CHOICES: TopicChoice[] = [...TOPICS, AGENT_CHOICE];

const LABELS: Record<TopicChoice, string> = {
  viral: "Viral",
  politics: "Politics",
  tech: "Tech",
  science: "Science",
  ai: "AI",
  philosophy: "Philosophy",
  concept: "Concept",
  agent: "Let the agent choose",
};

const BLURBS: Record<TopicChoice, string> = {
  viral: "Whatever the feeds cannot stop arguing about right now.",
  politics: "Contested civic ground — policy, power, and who pays.",
  tech: "Platforms, hardware, and the people they reshape.",
  science: "New findings, and the fights about what they mean.",
  ai: "Models, labour, authorship, and the line between them.",
  philosophy: "The old questions, asked against this week's news.",
  concept: "An idea rather than an event — abstract, argued from first principles.",
  agent: "Rank across every topic and take the strongest signal available.",
};

export function topicLabel(choice: TopicChoice): string {
  return LABELS[choice];
}

export function topicBlurb(choice: TopicChoice): string {
  return BLURBS[choice];
}

/** The fragment's wash. The agent's choice keeps the full dispersed rainbow; a named topic takes its own hue. */
export function topicColor(choice: TopicChoice): string {
  if (choice === AGENT_CHOICE) return "";
  return `var(--topic-${choice})`;
}

/** A soft version of the same hue for the drop-shadow halo, so the glow reads as light and not as a border. */
export function topicHalo(choice: TopicChoice): string {
  if (choice === AGENT_CHOICE) return "rgba(150, 120, 255, 0.55)";
  return `color-mix(in srgb, var(--topic-${choice}) 62%, transparent)`;
}

/** The tint layer composites `multiply`, so a flat hue would swallow the fragment's facets. A gradient keeps the glass visible through the colour. */
export function topicWash(choice: TopicChoice): string {
  if (choice === AGENT_CHOICE) return "";
  const c = topicColor(choice);
  return `radial-gradient(120% 120% at 30% 25%, color-mix(in srgb, ${c} 42%, white), color-mix(in srgb, ${c} 88%, white) 70%, ${c})`;
}

export function isAgentChoice(choice: TopicChoice): choice is typeof AGENT_CHOICE {
  return choice === AGENT_CHOICE;
}
