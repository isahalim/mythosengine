import { describe, expect, it } from "vitest";
import { Bm25Index, tokenize } from "./bm25.ts";

describe("tokenize", () => {
  it("lowercases, splits on punctuation, and drops single characters", () => {
    expect(tokenize("Rockstar's GTA VI delay: a $2B problem?")).toEqual(["rockstar", "gta", "vi", "delay", "2b", "problem"]);
  });

  it("stems a query term onto the document's inflected form", () => {
    // The miss that put the stemmer here: without it, "delay" and "delayed"
    // are unrelated terms and the delay story loses to a trailer breakdown.
    expect(tokenize("delay")).toEqual(tokenize("delayed"));
    expect(tokenize("sales")).toEqual(tokenize("sale"));
    expect(tokenize("announcing")).toEqual(tokenize("announced"));
  });

  it("leaves short words and -ss endings alone", () => {
    expect(tokenize("ads bed loss press")).toEqual(["ads", "bed", "loss", "press"]);
  });

  it("keeps non-ASCII letters and digits", () => {
    expect(tokenize("Café müsli 2026")).toEqual(["café", "müsli", "2026"]);
  });

  it("returns nothing for text with no words", () => {
    expect(tokenize("!!! --- ???")).toEqual([]);
  });
});

describe("Bm25Index", () => {
  const corpus = [
    { id: "a", text: "GTA VI delayed again, Rockstar confirms a 2027 window" },
    { id: "b", text: "Rockstar employees return to the office five days a week" },
    { id: "c", text: "Steam Deck sales overtake the Switch in Europe" },
    { id: "d", text: "A GTA VI trailer breakdown: every frame analysed" },
    { id: "e", text: "Nintendo announces a new Zelda for the Switch" },
  ];

  it("ranks the document that matches most of the query first", () => {
    const hits = new Bm25Index(corpus).search("GTA VI delay", 3);
    expect(hits[0].id).toBe("a");
    expect(hits.map((h) => h.id)).toContain("d");
  });

  it("omits documents that match nothing rather than returning them with score 0", () => {
    const hits = new Bm25Index(corpus).search("GTA", 10);
    expect(hits.map((h) => h.id).sort()).toEqual(["a", "d"]);
  });

  it("respects topK", () => {
    expect(new Bm25Index(corpus).search("the", 2).length).toBeLessThanOrEqual(2);
  });

  it("prefers the shorter document when both contain the query term equally", () => {
    // Length normalization (the b parameter) is the whole reason BM25 beats
    // raw term counting here: a term in a 5-word headline says more about
    // that headline than the same term buried in a 50-word one.
    const hits = new Bm25Index([
      { id: "short", text: "Rockstar delay" },
      { id: "long", text: `Rockstar delay ${"filler word ".repeat(30)}` },
    ]).search("delay", 2);
    expect(hits[0].id).toBe("short");
  });

  it("ignores a term that appears in more than half the corpus", () => {
    // "rockstar" is in 3 of 4 here, so it discriminates nothing; the ranking
    // has to be decided by "layoffs" alone.
    const hits = new Bm25Index([
      { id: "a", text: "Rockstar delay" },
      { id: "b", text: "Rockstar office" },
      { id: "c", text: "Rockstar layoffs reported" },
      { id: "d", text: "Steam Deck sales" },
    ]).search("rockstar layoffs", 4);
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe("c");
  });

  it("returns the same order every time for the same corpus and query", () => {
    const index = new Bm25Index(corpus);
    expect(index.search("Switch", 5)).toEqual(index.search("Switch", 5));
  });

  it("handles an empty corpus and an empty query without throwing", () => {
    expect(new Bm25Index([]).search("anything", 5)).toEqual([]);
    expect(new Bm25Index(corpus).search("", 5)).toEqual([]);
    expect(new Bm25Index([]).size).toBe(0);
  });
});
