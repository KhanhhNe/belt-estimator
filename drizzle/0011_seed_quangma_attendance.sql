INSERT INTO `users` (`username`, `password`, `unique_code`)
VALUES ('quangma', 'quangma', 'QUANGMA')
ON CONFLICT(`username`) DO UPDATE SET
	`password` = excluded.`password`,
	`unique_code` = excluded.`unique_code`;

INSERT INTO `attendance_records` (`date`, `user_id`)
SELECT `dates`.`date`, `users`.`id`
FROM (
	SELECT `column1` AS `date`
	FROM (VALUES
		('2026-03-09'),
		('2026-03-10'),
		('2026-03-11'),
		('2026-03-12'),
		('2026-03-15'),
		('2026-03-16'),
		('2026-03-17'),
		('2026-03-18'),
		('2026-03-19'),
		('2026-03-20'),
		('2026-03-21'),
		('2026-03-22'),
		('2026-03-23'),
		('2026-03-24'),
		('2026-03-25'),
		('2026-03-26'),
		('2026-03-27'),
		('2026-03-29'),
		('2026-05-06'),
		('2026-05-07'),
		('2026-05-08'),
		('2026-05-09'),
		('2026-05-10'),
		('2026-05-11'),
		('2026-05-12'),
		('2026-05-13'),
		('2026-05-14'),
		('2026-05-15')
	)
) AS `dates`
JOIN `users` ON `users`.`username` = 'quangma'
ON CONFLICT(`user_id`, `date`) DO NOTHING;