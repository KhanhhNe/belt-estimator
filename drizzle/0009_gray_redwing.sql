UPDATE `users`
SET `is_admin` = CASE
	WHEN `username` = 'khanhhne' THEN 1
	ELSE 0
END;