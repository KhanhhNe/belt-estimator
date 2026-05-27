INSERT INTO `users` (`username`, `password`, `unique_code`)
VALUES ('khanhhne', 'kh@nhlu0ng', 'Kh4nhN3e')
ON CONFLICT(`username`) DO UPDATE SET
	`password` = excluded.`password`,
	`unique_code` = excluded.`unique_code`;

UPDATE `attendance_records`
SET `user_id` = (
	SELECT `id`
	FROM `users`
	WHERE `username` = 'khanhhne'
	LIMIT 1
)
WHERE `user_id` IS NULL;
