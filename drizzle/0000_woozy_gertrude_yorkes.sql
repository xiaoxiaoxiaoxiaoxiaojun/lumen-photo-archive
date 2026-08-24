CREATE TABLE `photos` (
	`id` text PRIMARY KEY NOT NULL,
	`object_key` text NOT NULL,
	`title` text NOT NULL,
	`category` text DEFAULT '旅途' NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`captured_at` text DEFAULT '' NOT NULL,
	`content_type` text NOT NULL,
	`owner_sub` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `photos_object_key_unique` ON `photos` (`object_key`);--> statement-breakpoint
CREATE INDEX `photos_created_at_idx` ON `photos` (`created_at`);