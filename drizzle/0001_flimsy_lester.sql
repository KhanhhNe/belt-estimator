CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`password` text NOT NULL,
	`unique_code` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_unique_code_unique` ON `users` (`unique_code`);--> statement-breakpoint
ALTER TABLE `attendance_records` ADD `user_id` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `attendance_records_date_unique` ON `attendance_records` (`date`);