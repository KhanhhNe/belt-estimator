require("dotenv").config();

const { client } = require("../src/db/client");

const ATTENDANCE_DATES = [
	"2026-03-09",
	"2026-03-10",
	"2026-03-17",
	"2026-03-18",
	"2026-03-19",
	"2026-03-23",
	"2026-03-25",
	"2026-03-26",
	"2026-03-31",
	"2026-04-01",
	"2026-04-02",
	"2026-04-06",
	"2026-04-07",
	"2026-04-08",
	"2026-04-09",
	"2026-04-10",
	"2026-04-17",
	"2026-04-20",
	"2026-04-21",
	"2026-04-24",
	"2026-05-04",
	"2026-05-05",
	"2026-05-06",
	"2026-05-07",
	"2026-05-13",
	"2026-05-14",
	"2026-05-18",
	"2026-05-19",
	"2026-05-20",
	"2026-05-21",
];

async function upsertAttendanceDates(dates) {
	const userLookup = await client.execute({
		sql: "select id from users where username = ? limit 1",
		args: ["khanhhne"],
	});

	const userId = userLookup.rows?.[0]?.id;
	if (!userId) {
		throw new Error("User khanhhne not found. Run migrations first.");
	}

	let inserted = 0;
	let skipped = 0;

	for (const date of dates) {
		const result = await client.execute({
			sql: `
				insert into attendance_records (date, user_id)
				select ?, ?
				where not exists (
					select 1 from attendance_records where date = ? and user_id = ?
				)
			`,
			args: [date, userId, date, userId],
		});

		if (result.rowsAffected === 1) {
			inserted += 1;
		} else {
			skipped += 1;
		}
	}

	return { inserted, skipped, total: dates.length };
}

async function main() {
	const summary = await upsertAttendanceDates(ATTENDANCE_DATES);

	console.log("Attendance sync complete:");
	console.log(`- Total processed: ${summary.total}`);
	console.log(`- Inserted: ${summary.inserted}`);
	console.log(`- Skipped (already existed): ${summary.skipped}`);
}

main().catch((error) => {
	console.error("Failed to sync attendance dates:", error);
	process.exit(1);
});
