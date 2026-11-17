CREATE TABLE `signer_decisions` (
	`profile_id` text NOT NULL,
	`scope` text NOT NULL,
	`repository_id` text,
	`fingerprint` text NOT NULL,
	`identity` text NOT NULL,
	`decision` text NOT NULL,
	CONSTRAINT `signer_decisions_pk` PRIMARY KEY(`profile_id`, `scope`, `fingerprint`),
	CONSTRAINT `fk_signer_decisions_profile_id_identities_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `identities`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_signer_decisions_profile_id_repository_id_repositories_identity_id_id_fk` FOREIGN KEY (`profile_id`,`repository_id`) REFERENCES `repositories`(`identity_id`,`id`) ON DELETE CASCADE,
	CONSTRAINT "signer_decision_scope" CHECK(("repository_id" IS NULL AND "scope" = 'profile') OR ("repository_id" IS NOT NULL AND "scope" = "repository_id")),
	CONSTRAINT "signer_decision_value" CHECK("decision" IN ('trusted', 'distrusted'))
);
--> statement-breakpoint
CREATE TABLE `verification_keys` (
	`profile_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`armored_key` text NOT NULL,
	`source` text NOT NULL,
	`fetched_at` text NOT NULL,
	CONSTRAINT `verification_keys_pk` PRIMARY KEY(`profile_id`, `fingerprint`),
	CONSTRAINT `fk_verification_keys_profile_id_identities_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `identities`(`id`) ON DELETE CASCADE
);
