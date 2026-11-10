-- Add visibility metadata without rebuilding or removing existing snapshots.
ALTER TABLE `recovery_runs` ADD `deleted_at` text;
--> statement-breakpoint
ALTER TABLE `recovery_runs` ADD `state_version` integer DEFAULT 0 NOT NULL
  CONSTRAINT `recovery_runs_state_version_check` CHECK (`state_version` >= 0);
