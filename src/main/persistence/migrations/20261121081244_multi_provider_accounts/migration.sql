ALTER TABLE `github_accounts` ADD `active` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `gitlab_accounts` ADD `active` integer DEFAULT true NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_github_accounts` (
	`profile_id` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`account_id` text NOT NULL,
	`login` text NOT NULL,
	`credential_ref` text NOT NULL,
	`state` text NOT NULL,
	CONSTRAINT `github_accounts_pk` PRIMARY KEY(`profile_id`, `account_id`),
	CONSTRAINT `fk_github_accounts_profile_id_identities_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `identities`(`id`) ON DELETE CASCADE,
	CONSTRAINT "github_accounts_state" CHECK("state" IN ('connected', 'expired', 'revoked'))
);
--> statement-breakpoint
INSERT INTO `__new_github_accounts`(`profile_id`, `account_id`, `login`, `credential_ref`, `state`) SELECT `profile_id`, `account_id`, `login`, `credential_ref`, `state` FROM `github_accounts`;--> statement-breakpoint
DROP TABLE `github_accounts`;--> statement-breakpoint
ALTER TABLE `__new_github_accounts` RENAME TO `github_accounts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_gitlab_accounts` (
	`profile_id` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`account_id` text NOT NULL,
	`login` text NOT NULL,
	`credential_ref` text NOT NULL,
	`state` text NOT NULL,
	CONSTRAINT `gitlab_accounts_pk` PRIMARY KEY(`profile_id`, `account_id`),
	CONSTRAINT `fk_gitlab_accounts_profile_id_identities_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `identities`(`id`) ON DELETE CASCADE,
	CONSTRAINT "gitlab_accounts_state" CHECK("state" IN ('connected', 'expired', 'revoked'))
);
--> statement-breakpoint
INSERT INTO `__new_gitlab_accounts`(`profile_id`, `account_id`, `login`, `credential_ref`, `state`) SELECT `profile_id`, `account_id`, `login`, `credential_ref`, `state` FROM `gitlab_accounts`;--> statement-breakpoint
DROP TABLE `gitlab_accounts`;--> statement-breakpoint
ALTER TABLE `__new_gitlab_accounts` RENAME TO `gitlab_accounts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `github_active_account` ON `github_accounts` (`profile_id`) WHERE "github_accounts"."active" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `gitlab_active_account` ON `gitlab_accounts` (`profile_id`) WHERE "gitlab_accounts"."active" = 1;