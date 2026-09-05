/**
 * How far the chat route's run has got, from counted facts.
 *
 * **What used to be in this file.** Until 2026-09-05 it was `orbit.ts`: ring
 * geometry, a gather easing, a three-axis tumble, an eight-layer extrusion so
 * a fragment turned edge-on was not zero pixels wide, dust seeds with
 * differential rotation, and `dockedFor`, which said which orbiting shard had
 * left the ring for the card. The orbit was removed whole by operator
 * direction ("completely remove the orbiting glass shards and debris"), and
 * the arithmetic went with it rather than being left behind for a caller that
 * no longer exists.
 *
 * The one thing that outlives it is the rule the orbit was driven by, and it
 * is the rule that mattered: progress on this screen is a count of things
 * that have observably happened, never an estimate and never a timer. The
 * same rule is stated in `Stage5Forge`, `ForgePane` and
 * `src/server/console/runs.ts`.
 */

/**
 * The fraction of the run's milestones that are true. Named for what it
 * counts rather than for what used to consume it — it was `dockedFraction`
 * while shards docked into the card.
 *
 * `Stage5Forge`'s `milestones` counts four; the chat route counts six,
 * because DIGEST and the brief's own signal both land before SCRIPT on this
 * route and the operator is watching them.
 */
export function milestoneFraction(milestones: readonly boolean[]): number {
  if (milestones.length === 0) return 0;
  return milestones.filter(Boolean).length / milestones.length;
}
