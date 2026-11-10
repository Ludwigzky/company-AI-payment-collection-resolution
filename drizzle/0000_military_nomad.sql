CREATE TABLE `recovery_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`record_id` text NOT NULL,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`object_key` text NOT NULL,
	`created_at` text NOT NULL,
	`removed_at` text,
	FOREIGN KEY (`owner_id`,`record_id`) REFERENCES `recovery_records`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recovery_attachments_size_check" CHECK("recovery_attachments"."size" > 0 AND "recovery_attachments"."size" <= 5242880)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recovery_attachments_owner_record_id_unique` ON `recovery_attachments` (`owner_id`,`record_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `recovery_attachments_object_key_unique` ON `recovery_attachments` (`object_key`);--> statement-breakpoint
CREATE INDEX `recovery_attachments_owner_record_active_idx` ON `recovery_attachments` (`owner_id`,`record_id`,`removed_at`);--> statement-breakpoint
CREATE TABLE `recovery_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`record_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`owner_id`,`record_id`) REFERENCES `recovery_records`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recovery_notes_owner_record_id_unique` ON `recovery_notes` (`owner_id`,`record_id`,`id`);--> statement-breakpoint
CREATE INDEX `recovery_notes_owner_record_created_idx` ON `recovery_notes` (`owner_id`,`record_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `recovery_records` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`number` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`input_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "recovery_records_status_check" CHECK("recovery_records"."status" IN ('active', 'archived')),
	CONSTRAINT "recovery_records_revision_check" CHECK("recovery_records"."revision" >= 1),
	CONSTRAINT "recovery_records_input_json_check" CHECK(json_valid("recovery_records"."input_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recovery_records_owner_id_unique` ON `recovery_records` (`owner_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `recovery_records_owner_number_unique` ON `recovery_records` (`owner_id`,`number`);--> statement-breakpoint
CREATE INDEX `recovery_records_owner_status_updated_idx` ON `recovery_records` (`owner_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `recovery_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`record_id` text NOT NULL,
	`revision` integer NOT NULL,
	`input_json` text NOT NULL,
	`attachment_ids_json` text DEFAULT '[]' NOT NULL,
	`plan_json` text NOT NULL,
	`material_summary_json` text DEFAULT 'null' NOT NULL,
	`snapshot_stale` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`owner_id`,`record_id`) REFERENCES `recovery_records`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recovery_runs_revision_check" CHECK("recovery_runs"."revision" >= 1),
	CONSTRAINT "recovery_runs_input_json_check" CHECK(json_valid("recovery_runs"."input_json")),
	CONSTRAINT "recovery_runs_attachments_json_check" CHECK(json_valid("recovery_runs"."attachment_ids_json")),
	CONSTRAINT "recovery_runs_plan_json_check" CHECK(json_valid("recovery_runs"."plan_json")),
	CONSTRAINT "recovery_runs_material_json_check" CHECK(json_valid("recovery_runs"."material_summary_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recovery_runs_owner_record_id_unique` ON `recovery_runs` (`owner_id`,`record_id`,`id`);--> statement-breakpoint
CREATE INDEX `recovery_runs_owner_record_created_idx` ON `recovery_runs` (`owner_id`,`record_id`,`created_at`);