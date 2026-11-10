CREATE TABLE `recovery_provider_settings` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`mode` text DEFAULT 'default' NOT NULL,
	`ciphertext` text,
	`iv` text,
	`model` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL,
	`probe_json` text,
	`probe_fingerprint` text,
	CONSTRAINT "recovery_provider_settings_revision_check" CHECK("recovery_provider_settings"."revision" >= 0),
	CONSTRAINT "recovery_provider_settings_mode_check" CHECK("recovery_provider_settings"."mode" IN ('default', 'custom', 'disabled')),
	CONSTRAINT "recovery_provider_settings_encryption_check" CHECK(("recovery_provider_settings"."mode" IN ('custom', 'disabled') AND "recovery_provider_settings"."ciphertext" IS NOT NULL AND "recovery_provider_settings"."iv" IS NOT NULL) OR ("recovery_provider_settings"."mode" IN ('default', 'disabled') AND "recovery_provider_settings"."ciphertext" IS NULL AND "recovery_provider_settings"."iv" IS NULL)),
	CONSTRAINT "recovery_provider_settings_probe_json_check" CHECK("recovery_provider_settings"."probe_json" IS NULL OR json_valid("recovery_provider_settings"."probe_json"))
);
