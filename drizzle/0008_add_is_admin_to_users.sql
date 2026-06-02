ALTER TABLE `users` ADD `is_admin` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `users`
SET `is_admin` = CASE
	WHEN `username` = 'khanhhne' THEN 1
	ELSE 0
END;