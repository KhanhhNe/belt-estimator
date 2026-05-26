require("dotenv").config({ quiet: true });
const express = require("express");
const path = require("node:path");
const { db } = require("./db/client");
const { attendanceRecords } = require("./db/schema");
const { getBeltStats } = require("./services/beltStats");

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "..", "public")));

function getUtcPlus7DateString(now = new Date()) {
	const localTimeInUtcPlus7 = new Date(now.getTime() + 7 * 60 * 60 * 1000);
	return localTimeInUtcPlus7.toISOString().slice(0, 10);
}

app.post("/api/record-attendance", async (_req, res) => {
	try {
		const attendanceDate = getUtcPlus7DateString();

		const result = await db
			.insert(attendanceRecords)
			.values({ date: attendanceDate })
			.onConflictDoNothing({ target: attendanceRecords.date })
			.returning({ insertedDate: attendanceRecords.date });

		const created = result.length > 0;

		res.json({
			created,
			date: attendanceDate,
			message: created
				? "Attendance recorded"
				: "Attendance already exists for this UTC+7 date",
		});
	} catch (error) {
		res.status(500).json({
			error: "Failed to record attendance",
			details: error.message,
		});
	}
});

app.get("/api/stats", async (_req, res) => {
	try {
		const stats = await getBeltStats();

		res.json({
			_docs: {
				recordAttendance:
					"POST /api/record-attendance records today's date using UTC+7 timezone. Idempotent: repeated calls for the same UTC+7 day do not create duplicates.",
				currentBeltStat:
					"Average attended weekdays across the best 8 weeks within the trailing 12-week window. Compare this value against 3.0.",
				sumBestEight:
					"Sum of attended weekdays from the selected best 8 weeks used to compute currentBeltStat (average = sumBestEight / 8).",
				currentMonthAttendance:
					"Number of attended weekdays recorded in the current calendar month up to today.",
				currentMonthAttendanceDates:
					"ISO date list (YYYY-MM-DD) of attended weekdays in the current month up to today. Intended for calendar highlighting.",
				currentDate:
					"Current date in ISO format (YYYY-MM-DD) used by backend while computing stats.",
				bestEightBreakdown:
					"Sorted counts selected as the best 8 weeks from the trailing 12-week window (used to compute sumBestEight).",
				trailingTwelveBreakdown:
					"Week-by-week attendance counts for the trailing 12-week window where index 0 is the current week.",
				wfhStartDateIfTodayAttended:
					"Date where max consecutive WFH counting starts when today is marked attended (tomorrow in UTC+0 date space, shifted to next weekday).",
				wfhStartDateIfTodayNotAttended:
					"Date where max consecutive WFH counting starts when today is not attended (today in UTC+0 date space, shifted to next weekday).",
				maximumConsecutiveWfhDays:
					"Maximum number of consecutive weekday WFH days from today that still keeps BELT compliant.",
				nextDayAttendanceStatChange:
					"Delta in maximumConsecutiveWfhDays when today is attended vs not attended. Positive means attending today increases allowed future consecutive WFH days.",
			},
			...stats,
		});
	} catch (error) {
		res.status(500).json({
			error: "Failed to compute BELT stats",
			details: error.message,
		});
	}
});

app.listen(port, () => {
	console.log(`Server listening on port ${port}`);
});
