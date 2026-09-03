-- The host stopped being a per-shot decision on 2026-09-03 (operator
-- direction): it now runs the pack's own actions in a fixed cycle for the
-- whole video, so PLAN no longer chooses one and there is nothing to store.
--
-- Dropped rather than left nullable-and-unwritten. A column nothing writes
-- reads as a feature that is merely off, and the next person to touch
-- `shot_plans` would have to go find out which. SQLite has supported
-- ALTER TABLE ... DROP COLUMN since 3.35 and D1 is well past that.
ALTER TABLE shot_plans DROP COLUMN character_action;
