PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL UNIQUE,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`git_name` text NOT NULL,
	`git_email` text NOT NULL,
	`username` text,
	`avatar_path` text,
	`ssh_key_path` text,
	`signing_format` text DEFAULT 'none' NOT NULL,
	`signing_key_ref` text,
	`sign_commits` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "identities_name" CHECK(length(trim("name")) BETWEEN 1 AND 100),
	CONSTRAINT "identities_name_key" CHECK(length("name_key") > 0),
	CONSTRAINT "identities_signing_format" CHECK("signing_format" IN ('ssh', 'gpg', 'none')),
	CONSTRAINT "identities_sign_commits" CHECK("sign_commits" IN (0, 1))
);
--> statement-breakpoint
INSERT INTO `__new_identities`(`id`, `name`, `name_key`, `sort_order`, `git_name`, `git_email`, `username`, `avatar_path`, `ssh_key_path`, `signing_format`, `signing_key_ref`, `sign_commits`, `created_at`, `updated_at`) SELECT `id`, `name`, `name_key`, `sort_order`, `git_name`, `git_email`, `username`, `avatar_path`, `ssh_key_path`, `signing_format`, `signing_key_ref`, `sign_commits`, `created_at`, `updated_at` FROM `identities`;--> statement-breakpoint
DROP TABLE `identities`;--> statement-breakpoint
ALTER TABLE `__new_identities` RENAME TO `identities`;--> statement-breakpoint
PRAGMA foreign_keys=ON;