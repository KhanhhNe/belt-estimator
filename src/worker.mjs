import { createClient } from "@libsql/client/web";
import { drizzle } from "drizzle-orm/libsql";
import { attendanceRecords } from "./db/schema.js";
import {
	getBeltStats,
	getBeltStatsFromAttendedDateStrings,
} from "./services/beltStats.js";

let cachedDb = null;
let cachedCredentialsKey = null;

const API_DOCS = {
	recordAttendance:
		"POST /api/record-attendance records today's date using UTC+7 timezone. Idempotent: repeated calls for the same UTC+7 day do not create duplicates.",
	previewStats:
		"POST /api/stats/preview accepts attendedDateStrings (array of YYYY-MM-DD) and returns recomputed BELT stats without writing to database.",
	currentBeltStat:
		"Average attended weekdays across the best 8 weeks within the trailing 12-week window. Compare this value against 3.0.",
	sumBestEight:
		"Sum of attended weekdays from the selected best 8 weeks used to compute currentBeltStat (average = sumBestEight / 8).",
	currentMonthAttendance:
		"Number of attended weekdays recorded in the current calendar month up to today.",
	currentMonthAttendanceDates:
		"ISO date list (YYYY-MM-DD) of attended dates in the current month. Intended for calendar highlighting and click-to-toggle UI state.",
	currentDate:
		"Current date in ISO format (YYYY-MM-DD) using UTC+7 day boundary used by backend while computing stats.",
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
};

function getUtcPlus7DateString(now = new Date()) {
	const localTimeInUtcPlus7 = new Date(now.getTime() + 7 * 60 * 60 * 1000);
	return localTimeInUtcPlus7.toISOString().slice(0, 10);
}

function isValidIsoDate(dateString) {
	if (typeof dateString !== "string") {
		return false;
	}

	if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
		return false;
	}

	const parsed = new Date(`${dateString}T00:00:00.000Z`);
	if (Number.isNaN(parsed.getTime())) {
		return false;
	}

	return parsed.toISOString().slice(0, 10) === dateString;
}

function json(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json",
		},
	});
}

function getDbForEnv(env) {
	const credentials = {
		TURSO_DATABASE_URL: env.TURSO_DATABASE_URL,
		TURSO_AUTH_TOKEN: env.TURSO_AUTH_TOKEN,
	};

	if (!credentials.TURSO_DATABASE_URL || !credentials.TURSO_AUTH_TOKEN) {
		throw new Error(
			"Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN in Worker environment",
		);
	}

	const credentialsKey = `${credentials.TURSO_DATABASE_URL}|${credentials.TURSO_AUTH_TOKEN}`;

	if (!cachedDb || cachedCredentialsKey !== credentialsKey) {
		const client = createClient({
			url: credentials.TURSO_DATABASE_URL,
			authToken: credentials.TURSO_AUTH_TOKEN,
		});
		cachedDb = drizzle({ client });
		cachedCredentialsKey = credentialsKey;
	}

	return cachedDb;
}

async function handleRecordAttendance(env) {
	try {
		const attendanceDate = getUtcPlus7DateString();
		const db = getDbForEnv(env);

		const result = await db
			.insert(attendanceRecords)
			.values({ date: attendanceDate })
			.onConflictDoNothing({ target: attendanceRecords.date })
			.returning({ insertedDate: attendanceRecords.date });

		const created = result.length > 0;

		return json({
			created,
			date: attendanceDate,
			message: created
				? "Attendance recorded"
				: "Attendance already exists for this UTC+7 date",
		});
	} catch (error) {
		return json(
			{
				error: "Failed to record attendance",
				details: error.message,
			},
			500,
		);
	}
}

async function handlePreviewStats(request) {
	try {
		const body = await request.json();
		const requestedDates = body?.attendedDateStrings;

		if (!Array.isArray(requestedDates)) {
			return json(
				{
					error: "Invalid attendedDateStrings",
					details: "Provide an array of ISO dates (YYYY-MM-DD)",
				},
				400,
			);
		}

		const invalidDate = requestedDates.find(
			(dateString) => !isValidIsoDate(dateString),
		);

		if (invalidDate) {
			return json(
				{
					error: "Invalid date",
					details: `Invalid ISO date: ${invalidDate}`,
				},
				400,
			);
		}

		const stats = getBeltStatsFromAttendedDateStrings(requestedDates);
		return json(stats);
	} catch (error) {
		return json(
			{
				error: "Failed to compute preview stats",
				details: error.message,
			},
			500,
		);
	}
}

async function handleStats(env) {
	try {
		const db = getDbForEnv(env);
		const stats = await getBeltStats(db);
		return json({
			_docs: API_DOCS,
			...stats,
		});
	} catch (error) {
		return json(
			{
				error: "Failed to compute BELT stats",
				details: error.message,
			},
			500,
		);
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (
			request.method === "POST" &&
			url.pathname === "/api/record-attendance"
		) {
			return handleRecordAttendance(env);
		}

		if (request.method === "POST" && url.pathname === "/api/stats/preview") {
			return handlePreviewStats(request);
		}

		if (request.method === "GET" && url.pathname === "/api/stats") {
			return handleStats(env);
		}

		return env.ASSETS.fetch(request);
	},
};
