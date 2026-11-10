CREATE TABLE `recovery_legal_events` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`record_id` text NOT NULL,
	`receivable_id` text,
	`supersedes_id` text,
	`data_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`owner_id`,`record_id`) REFERENCES `recovery_records`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`record_id`,`receivable_id`) REFERENCES `recovery_receivables`(`owner_id`,`record_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`record_id`,`supersedes_id`) REFERENCES `recovery_legal_events`(`owner_id`,`record_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recovery_legal_events_data_json_check" CHECK(json_valid("recovery_legal_events"."data_json")),
	CONSTRAINT "recovery_legal_events_not_self_check" CHECK("recovery_legal_events"."supersedes_id" IS NULL OR "recovery_legal_events"."supersedes_id" != "recovery_legal_events"."id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recovery_legal_events_owner_record_id_unique` ON `recovery_legal_events` (`owner_id`,`record_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `recovery_legal_events_supersedes_unique` ON `recovery_legal_events` (`owner_id`,`supersedes_id`);--> statement-breakpoint
CREATE INDEX `recovery_legal_events_owner_record_created_idx` ON `recovery_legal_events` (`owner_id`,`record_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `recovery_receivable_history` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`record_id` text NOT NULL,
	`receivable_id` text NOT NULL,
	`revision` integer NOT NULL,
	`data_json` text NOT NULL,
	`change_reason` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`owner_id`,`record_id`,`receivable_id`) REFERENCES `recovery_receivables`(`owner_id`,`record_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recovery_receivable_history_revision_check" CHECK("recovery_receivable_history"."revision" >= 1),
	CONSTRAINT "recovery_receivable_history_data_json_check" CHECK(json_valid("recovery_receivable_history"."data_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recovery_receivable_history_revision_unique` ON `recovery_receivable_history` (`owner_id`,`receivable_id`,`revision`);--> statement-breakpoint
CREATE INDEX `recovery_receivable_history_owner_record_idx` ON `recovery_receivable_history` (`owner_id`,`record_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `recovery_receivables` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`record_id` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`data_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`owner_id`,`record_id`) REFERENCES `recovery_records`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recovery_receivables_revision_check" CHECK("recovery_receivables"."revision" >= 1),
	CONSTRAINT "recovery_receivables_data_json_check" CHECK(json_valid("recovery_receivables"."data_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recovery_receivables_owner_record_id_unique` ON `recovery_receivables` (`owner_id`,`record_id`,`id`);--> statement-breakpoint
CREATE INDEX `recovery_receivables_owner_record_updated_idx` ON `recovery_receivables` (`owner_id`,`record_id`,`updated_at`);
--> statement-breakpoint
CREATE TRIGGER recovery_receivable_history_no_update BEFORE UPDATE ON recovery_receivable_history
BEGIN SELECT RAISE(ABORT, 'receivable history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER recovery_receivable_history_no_delete BEFORE DELETE ON recovery_receivable_history
BEGIN SELECT RAISE(ABORT, 'receivable history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER recovery_legal_events_no_update BEFORE UPDATE ON recovery_legal_events
BEGIN SELECT RAISE(ABORT, 'legal events are append only'); END;
--> statement-breakpoint
CREATE TRIGGER recovery_legal_events_no_delete BEFORE DELETE ON recovery_legal_events
BEGIN SELECT RAISE(ABORT, 'legal events are append only'); END;
