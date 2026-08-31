ALTER TABLE `scripts` ADD `beats` text;--> statement-breakpoint
ALTER TABLE `scripts` ADD `target_duration_s` integer;
--> statement-breakpoint
-- Plan v2 §4 (the discourse format). `beats` is the ordered `{move, text}`
-- list the single host performs; `move` is what replaced the second speaker
-- when the format was cut to one host on 2026-08-31, and it is what every
-- downstream stage varies on — TTS delivery, caption emphasis, footage cuts.
--
-- Both nullable, and that nullability is the format boundary rather than an
-- oversight: a row with `beats` is a v2 discourse script, a row without is a
-- v1 prose script. `body` still holds the spoken narration in both cases, so
-- the export, audit and console paths never branch on which format a row is.
