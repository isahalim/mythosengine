/**
 * Stage 4 — the stories (board 2).
 *
 * "now a larger piece of glass shard gets added (same design principle)":
 * each video grows a third, larger fragment, and the same caustic dial
 * picks which story it carries.
 *
 * Candidates come from GET /console/ideas, ranked by BM25 and nothing else.
 * Entering this stage re-runs WATCH's ingest **once** first, so the corpus
 * holds the latest discourse rather than whatever the last scheduled poll
 * left behind.
 *
 * A model reranker sat on the per-topic path for one day (2026-09-02) and
 * was removed on 2026-09-03 by operator direction. It reordered the same
 * corpus with the same prompt every visit, so it cost a request and landed
 * in nearly the same order. Freshness is what this screen was missing, and
 * freshness comes from the ingest plus a recency weight in the rank
 * (src/server/console/ideas.ts) — both plain code, no credential, no
 * degraded mode to explain to the operator.
 *
 * The ingest is still optional and still cannot fail the screen: a feed that
 * does not answer leaves the operator looking at the ideas they would have
 * seen anyway, with a line saying so.
 *
 * A video whose operator chose "let the agent decide" is ranked across every
 * topic and the strongest signal wins; the topic that won is recorded,
 * because "agent" is not a topic the queue accepts.
 */
import { useCallback, useEffect, useState } from "react";
import { cancelRunPick, describeError, getRunPlan, listIdeas, refreshIdeaSources } from "../api.ts";
import type { DriverError } from "../../lib/drivers/types.ts";
import { FloatingField, FloatingGroup, ringPositions } from "../glass/FloatingField.tsx";
import { videoShards } from "../glass/videoGlass.ts";
import { isAgentChoice, topicHalo, topicLabel, topicWash } from "../topics.ts";
import type { VideoSpec } from "../state.ts";
import { TOPICS, type QueuedPickView, type RankedIdea, type Topic } from "../types.ts";
import { Button } from "../ui/Button.tsx";
import { RadialDial, type DialItem } from "../ui/RadialDial.tsx";
import { StageFrame } from "../ui/StageFrame.tsx";

const PER_TOPIC = 4;

/** A candidate plus the topic it was ranked under — the pair is what stage 5 queues. */
interface Candidate {
  idea: RankedIdea;
  topic: Topic;
}

interface Stage4Props {
  videos: VideoSpec[];
  onSetIdea: (slot: number, idea: RankedIdea, topic: Topic) => void;
  onConfirm: () => void;
  onUnauthorized: () => void;
  complete: boolean;
  busy: boolean;
  dispatchError: string | null;
}

export function Stage4Ideas({ videos, onSetIdea, onConfirm, onUnauthorized, complete, busy, dispatchError }: Stage4Props) {
  const [open, setOpen] = useState<number | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Picks left queued by a run the operator started specifying and then
   * abandoned. They matter because GET /console/ideas excludes anything
   * already queued (src/server/console/ideas.ts), so a forgotten plan
   * silently shrinks the candidate pool for every future run and there is
   * otherwise nothing in this surface that can clear it.
   */
  const [stale, setStale] = useState<QueuedPickView[]>([]);
  const [clearing, setClearing] = useState(false);
  /**
   * What the entry refresh managed, or null before it has finished.
   *
   * Held rather than discarded because "the ideas look the same as last
   * time" has two very different causes — nothing new was published, or the
   * feeds did not answer — and only one of them is worth the operator's
   * attention.
   */
  const [freshness, setFreshness] = useState<string | null>(null);
  /**
   * Whether the one-per-entry ingest has finished. The per-topic fetch waits
   * on it: ranking the corpus before the refresh lands would show the
   * operator yesterday's ideas and then not update them.
   */
  const [refreshed, setRefreshed] = useState(false);

  const openVideo = videos.find((v) => v.slot === open) ?? null;
  const positions = ringPositions(videos.length);

  const glassFor = (video: VideoSpec) =>
    videoShards({
      slot: video.slot,
      topicWash: video.topic === null || isAgentChoice(video.topic) ? null : topicWash(video.topic),
      topicHalo: video.topic === null ? null : topicHalo(video.topic),
      ideaWash: video.ideaTopic === null ? null : topicWash(video.ideaTopic),
      ideaHalo: video.ideaTopic === null ? null : topicHalo(video.ideaTopic),
      withFuse: true,
      withIdea: video.idea !== null,
    });

  const fail = useCallback(
    (e: DriverError): void => {
      if (e.message.startsWith("HTTP 401")) {
        onUnauthorized();
        return;
      }
      setError(describeError(e));
    },
    [onUnauthorized],
  );

  useEffect(() => {
    let cancelled = false;
    void getRunPlan().then((result) => {
      if (cancelled || !result.ok) return;
      setStale(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * The stage 3 -> stage 4 refresh: WATCH's ingest, once, on entry.
   *
   * On mount rather than per topic, because a video set to "let the agent
   * decide" asks for all seven topics at once and seven crawls of the same
   * five feeds is a race rather than a refresh.
   *
   * `setRefreshed(true)` runs on both paths. A failed refresh must not leave
   * the per-topic fetch waiting forever for an ingest that is never coming —
   * the operator gets the corpus as it stands, which is what they had before
   * this existed.
   */
  useEffect(() => {
    let cancelled = false;
    void refreshIdeaSources().then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setFreshness(`Could not refresh the sources (${describeError(result.error)}) — showing the stories already gathered.`);
      } else if (result.value.degradedReason !== null) {
        setFreshness(`Refreshed with ${result.value.newSignals} new story(s); ${result.value.degradedReason}.`);
      } else if (result.value.newSignals > 0) {
        setFreshness(`${result.value.newSignals} new story(s) from ${result.value.sourcesFetched} source(s).`);
      } else {
        setFreshness(`No new stories since the last check — ${result.value.sourcesFetched} source(s) answered.`);
      }
      setRefreshed(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const clearStale = useCallback(async () => {
    setClearing(true);
    // Sequential, not Promise.all: these are mutations, and the router
    // gives each one its own audit row. A burst of parallel DELETEs buys
    // nothing here and makes a partial failure harder to reason about.
    for (const pick of stale) {
      const result = await cancelRunPick(pick.id);
      if (!result.ok) {
        setClearing(false);
        setError(`Could not clear the queued plan: ${describeError(result.error)}`);
        return;
      }
    }
    setClearing(false);
    setStale([]);
  }, [stale]);

  useEffect(() => {
    if (open === null) return;
    // Waits on the entry refresh. Ranking before the ingest lands would show
    // the operator the previous corpus and never correct it, which is the
    // exact failure this stage was changed to fix.
    if (!refreshed) return;
    const video = videos.find((v) => v.slot === open);
    if (video === undefined || video.topic === null) return;
    const choice = video.topic;

    // Nothing already spoken for elsewhere in this run should be offered
    // again, or one run makes two videos about the same story. Built
    // inside the effect: as a render-scope const it would be a fresh array
    // every pass, and depending on it would re-fetch forever.
    const taken = videos.filter((v) => v.slot !== open && v.idea !== null).map((v) => v.idea?.signalId ?? "");

    let cancelled = false;

    setLoading(true);
    setError(null);
    setCandidates([]);

    // ---- one topic ----
    //
    // The server returns them already ordered, so nothing here re-sorts.
    if (!isAgentChoice(choice)) {
      void listIdeas(choice, PER_TOPIC, taken).then((result) => {
        if (cancelled) return;
        setLoading(false);
        if (!result.ok) {
          fail(result.error);
          return;
        }
        setCandidates(result.value.map((idea) => ({ idea, topic: choice })));
      });
      return () => {
        cancelled = true;
      };
    }

    // ---- "let the agent decide": every topic at once ----
    //
    // The agent's pick genuinely ranks across every topic rather than
    // quietly defaulting to one — that is what the dial promised. `score` is
    // the only value here comparable across topics, which is what the merge
    // below sorts on.
    void Promise.all([...TOPICS].map((t) => listIdeas(t, PER_TOPIC, taken).then((r) => ({ topic: t, result: r })))).then((settled) => {
      if (cancelled) return;
      setLoading(false);

      const firstFailure = settled.find((s) => !s.result.ok);
      const gathered: Candidate[] = [];
      for (const { topic, result } of settled) {
        if (!result.ok) continue;
        for (const idea of result.value) gathered.push({ idea, topic });
      }

      // A partial failure is reported, never papered over: if some topics
      // answered we show those and say the rest did not, rather than
      // presenting a short list as though it were the whole ranking.
      if (gathered.length === 0 && firstFailure !== undefined && !firstFailure.result.ok) {
        fail(firstFailure.result.error);
        return;
      }
      if (firstFailure !== undefined) setError("Some topics could not be ranked — showing the ones that answered.");

      gathered.sort((a, b) => b.idea.score - a.idea.score);
      setCandidates(gathered.slice(0, 6));
    });

    return () => {
      cancelled = true;
    };
    // `videos` is the reducer's own array, so its identity is stable between
    // unrelated renders — safe to depend on directly.
  }, [open, videos, fail, refreshed]);

  const dialItems: DialItem[] = candidates.map((c, i) => ({
    id: c.idea.signalId,
    label: `Idea ${i + 1}`,
    detail: `${c.idea.title} · ${topicLabel(c.topic)} · ${c.idea.sourceKind}`,
    hue: `var(--topic-${c.topic})`,
  }));

  return (
    <StageFrame
      eyebrow="Step 3 of 5"
      title="Pick the story each one tells"
      blurb="A larger shard joins each video. Ranked from the signals corpus by BM25 — no model wrote this list, it is what the sources actually say."
      footer={
        <>
          {dispatchError !== null && <span className="max-w-sm font-mono text-xs text-rose">{dispatchError}</span>}
          <span className="font-mono text-xs text-bone">
            {videos.filter((v) => v.idea !== null).length} / {videos.length} chosen
          </span>
          <Button variant="primary" disabled={!complete || busy} onClick={onConfirm}>
            {busy ? "Deploying agents…" : "Deploy agents →"}
          </Button>
        </>
      }
    >
      {stale.length > 0 && (
        <div className="resolve-in pointer-events-auto mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-sodium/25 bg-sodium/5 px-4 py-2">
          <p className="font-mono text-xs text-sodium">
            {stale.length} pick{stale.length === 1 ? "" : "s"} from an earlier run are still queued, and their stories are being held back from the
            rankings below.
          </p>
          <Button variant="ghost" className="!px-3 !py-1 !text-xs" disabled={clearing} onClick={() => void clearStale()}>
            {clearing ? "Clearing…" : "Clear them"}
          </Button>
        </div>
      )}

      <FloatingField>
        {videos.map((video, i) => (
          <FloatingGroup
            key={video.slot}
            seed={video.slot + 1}
            box={positions[i]}
            shards={glassFor(video)}
            onClick={() => setOpen(video.slot)}
            label={`Video ${i + 1} — ${video.idea === null ? "choose a story" : video.idea.title}`}
            caption={
              <>
                <p className="font-mono text-[0.58rem] uppercase tracking-[0.2em] text-bone">
                  Video {i + 1} · {video.topic === null ? "—" : topicLabel(video.topic)}
                </p>
                <p className="mx-auto line-clamp-2 max-w-[16rem] font-display text-xs font-semibold leading-snug tracking-tight text-mercury">
                  {video.idea?.title ?? "Choose a story"}
                </p>
              </>
            }
          />
        ))}
      </FloatingField>

      {openVideo !== null && (
        <RadialDial
          items={dialItems}
          // Freshness is the last line, not the first: it is context for the
          // list, and it must never displace an error or the pick prompt.
          // "The ideas look the same" has two causes — nothing new was
          // published, or the feeds did not answer — and only the operator
          // can tell which matters.
          hint={
            !refreshed
              ? "Checking the sources for new stories…"
              : loading
                ? "Ranking the corpus…"
                : (error ?? (dialItems.length === 0 ? "No eligible signals for this topic right now." : (freshness ?? "Move across a story to light it.")))
          }
          center={
            <FloatingGroup seed={openVideo.slot + 1} box={{ x: 0, y: 0, w: 100, h: 100 }} shards={glassFor(openVideo)} />
          }
          onPick={(id) => {
            const picked = candidates.find((c) => c.idea.signalId === id);
            if (picked === undefined) return;
            onSetIdea(openVideo.slot, picked.idea, picked.topic);
            setOpen(null);
          }}
          onDismiss={() => setOpen(null)}
        />
      )}
    </StageFrame>
  );
}
