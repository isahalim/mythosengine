ALTER TABLE `footage_sources` ADD `enabled` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- Operator directive, 2026-08-30: footage comes from @HollowPoiint only.
-- His walkthroughs run about an hour, which is what makes a 1080p pull
-- affordable (~1.6 GB against the download driver's 6 GB ceiling) where
-- MKIceAndFire's 4h37m/17h25m/14h40m candidates were not — see
-- ARCHITECTURE.md §5.0. Disabled, not deleted: these two rows still own
-- footage_segments that already-exported renders point at, and §9 requires
-- that provenance to stay readable. Re-enable with an UPDATE.
UPDATE `footage_sources` SET `enabled` = 0 WHERE `id` IN ('mkiceandfire-gta', 'gtaseriesvideos-gta');
