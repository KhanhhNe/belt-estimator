PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_attendance_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`user_id` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_attendance_records`("id", "date", "user_id") SELECT "id", "date", "user_id" FROM `attendance_records`;--> statement-breakpoint
DROP TABLE `attendance_records`;--> statement-breakpoint
ALTER TABLE `__new_attendance_records` RENAME TO `attendance_records`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `attendance_records_user_date_unique` ON `attendance_records` (`user_id`,`date`);