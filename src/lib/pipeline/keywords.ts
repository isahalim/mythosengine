/**
 * Visual keywords for a script — what the console's waiting screen searches
 * Pexels for while a run works (plan v2 §7 step 4).
 *
 * Deliberately not a model call. This runs inside the Worker on every poll
 * of a live run, and the whole justification for spending a token is
 * ambiguity a model resolves better than code (CLAUDE.md's stack note on
 * the footage converter). "Which nouns in this paragraph are worth a stock
 * clip" is a ranking problem over ~160 words, and a frequency-plus-position
 * heuristic answers it well enough for a preview montage — which is what
 * this feeds, never the rendered video.
 *
 * When the PLAN stage lands (plan v2 §8 item 4) it will produce a real shot
 * list with its own keywords, and this becomes the fallback for scripts
 * written before it. The console reads whichever exists.
 */

/**
 * Fixed English stop list, not a corpus-derived one. The BM25 retriever
 * (src/lib/rag/bm25.ts) derives its stopwords from document frequency
 * because it ranks *within* a corpus; there is no corpus here — one script,
 * scored on its own — so the general list is the right instrument.
 */
const STOPWORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and", "any", "are", "as", "at",
  "be", "because", "been", "before", "being", "below", "between", "both", "but", "by",
  "can", "cannot", "could", "did", "do", "does", "doing", "down", "during",
  "each", "even", "every", "few", "for", "from", "further",
  "had", "has", "have", "having", "he", "her", "here", "hers", "herself", "him", "himself", "his", "how", "however",
  "i", "if", "in", "into", "is", "it", "its", "itself", "just",
  "like", "me", "more", "most", "much", "must", "my", "myself",
  "no", "nor", "not", "now", "of", "off", "on", "once", "one", "only", "or", "other", "ought", "our", "ours", "ourselves", "out", "over", "own",
  "really", "same", "she", "should", "so", "some", "still", "such",
  "than", "that", "the", "their", "theirs", "them", "themselves", "then", "there", "these", "they", "this", "those", "through", "to", "too",
  "under", "until", "up", "very", "was", "way", "we", "were", "what", "when", "where", "whether", "which", "while", "who", "whom", "why", "will", "with", "would",
  "you", "your", "yours", "yourself", "yourselves",
]);

/** Below this a token is noise ("ai" is the exception the check below allows through). */
const MIN_TOKEN_LENGTH = 3;

export interface KeywordSource {
  hook: string;
  body: string;
  debateQuestion?: string;
}

interface Candidate {
  /** Lowercased search phrase — what actually goes to Pexels. */
  phrase: string;
  score: number;
  firstSeen: number;
}

interface Token {
  raw: string;
  lower: string;
  /** True for a token that was capitalized mid-sentence — a proper noun, most of the time. */
  proper: boolean;
  index: number;
}

function tokenize(text: string, startIndex: number): Token[] {
  const tokens: Token[] = [];
  let index = startIndex;
  // Sentence-aware only to the extent it needs to be: a capitalized word
  // right after a full stop is capitalized by grammar, not by being a name,
  // and counting it as a proper noun would rank every sentence's first word.
  let atSentenceStart = true;

  for (const match of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'-]*|[.!?]/gu)) {
    const raw = match[0];
    if (raw === "." || raw === "!" || raw === "?") {
      atSentenceStart = true;
      continue;
    }
    tokens.push({
      raw,
      lower: raw.toLowerCase(),
      proper: !atSentenceStart && /^\p{Lu}/u.test(raw),
      index: index++,
    });
    atSentenceStart = false;
  }

  return tokens;
}

function isContentWord(token: Token): boolean {
  if (STOPWORDS.has(token.lower)) return false;
  if (/^\p{N}+$/u.test(token.lower)) return false; // a bare number searches for nothing
  // "ai" is two characters and is the single most likely subject in this
  // system's topic mix (plan v2 §7 step 2 lists it as a topic of its own).
  return token.lower.length >= MIN_TOKEN_LENGTH || token.lower === "ai";
}

function bump(map: Map<string, Candidate>, phrase: string, score: number, firstSeen: number): void {
  const existing = map.get(phrase);
  if (existing) {
    existing.score += score;
    return;
  }
  map.set(phrase, { phrase, score, firstSeen });
}

/**
 * Ranked visual keywords, most searchable first.
 *
 * Scoring, and why each term is there:
 * - **Position.** The hook is the script's visual thesis — it is the line
 *   the opening shot has to carry — so its words are worth more than the
 *   body's, and the debate question (a rhetorical closer, usually abstract)
 *   is worth least.
 * - **Repetition.** A word the script returns to is what the script is
 *   about.
 * - **Proper nouns.** A capitalized mid-sentence word is a name, a place or
 *   a product, and stock libraries index those well.
 * - **Adjacent pairs.** "surveillance camera" retrieves a usable clip;
 *   "surveillance" and "camera" separately retrieve two unrelated ones. A
 *   pair only survives if it actually repeats or is proper — otherwise
 *   every adjacent word pair in the script would outrank its own nouns.
 */
export function extractKeywords(script: KeywordSource, limit = 6): string[] {
  const hookTokens = tokenize(script.hook, 0);
  const bodyTokens = tokenize(script.body, hookTokens.length);
  const questionTokens = tokenize(script.debateQuestion ?? "", hookTokens.length + bodyTokens.length);

  const candidates = new Map<string, Candidate>();

  const sections: { tokens: Token[]; weight: number }[] = [
    { tokens: hookTokens, weight: 3 },
    { tokens: bodyTokens, weight: 1 },
    { tokens: questionTokens, weight: 0.5 },
  ];

  for (const { tokens, weight } of sections) {
    for (const token of tokens) {
      if (!isContentWord(token)) continue;
      bump(candidates, token.lower, weight * (token.proper ? 2 : 1), token.index);
    }

    for (let i = 0; i < tokens.length - 1; i++) {
      const [left, right] = [tokens[i], tokens[i + 1]];
      if (!isContentWord(left) || !isContentWord(right)) continue;
      const phrase = `${left.lower} ${right.lower}`;
      // Seeded at zero: a pair scores only through repetition (each later
      // occurrence bumps it) or through being a proper-noun pair. A pair
      // seen once, in lowercase, stays at zero and is dropped below.
      bump(candidates, phrase, left.proper && right.proper ? weight * 3 : 0, left.index);
      const seen = candidates.get(phrase);
      if (seen && seen.firstSeen !== left.index) seen.score += weight * 2;
    }
  }

  return [...candidates.values()]
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.firstSeen - b.firstSeen)
    .slice(0, limit)
    .map((candidate) => candidate.phrase);
}
