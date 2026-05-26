const { asc } = require("drizzle-orm");
const { db } = require("../db/client");
const { attendanceRecords } = require("../db/schema");

const TOTAL_WEEKS = 12;
const BEST_WEEKS_COUNT = 8;
const COMPLIANCE_THRESHOLD = 3;
const MAX_SIMULATION_DAYS = 365;

function parseIsoDate(dateString) {
	const [year, month, day] = dateString.split("-").map(Number);
	return new Date(Date.UTC(year, month - 1, day));
}

function formatIsoDate(date) {
	return date.toISOString().slice(0, 10);
}

function utcDateOnly(date) {
	return new Date(
		Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
	);
}

function addDays(date, days) {
	const next = utcDateOnly(date);
	next.setUTCDate(next.getUTCDate() + days);
	return next;
}

function isWeekday(date) {
	const day = date.getUTCDay();
	return day >= 1 && day <= 5;
}

function startOfWeekMonday(date) {
	const start = utcDateOnly(date);
	const dayOffset = (start.getUTCDay() + 6) % 7;
	start.setUTCDate(start.getUTCDate() - dayOffset);
	return start;
}

function getWeeklyAttendanceCounts(attendedDates, asOfDate) {
	const asOf = utcDateOnly(asOfDate);
	// Week index 0 is always the current week (Mon-Sun), so trailing 12 weeks includes this week.
	const currentWeekStart = startOfWeekMonday(asOf);

	const weeklyCounts = [];

	for (let weekIndex = 0; weekIndex < TOTAL_WEEKS; weekIndex += 1) {
		const weekStart = addDays(currentWeekStart, -weekIndex * 7);
		const weekEnd = addDays(weekStart, 6);
		const cappedWeekEnd = weekEnd < asOf ? weekEnd : asOf;

		let count = 0;
		for (const attendedDate of attendedDates) {
			if (attendedDate < weekStart || attendedDate > cappedWeekEnd) {
				continue;
			}

			if (isWeekday(attendedDate)) {
				count += 1;
			}
		}

		weeklyCounts.push(count);
	}

	return weeklyCounts;
}

function calculateBeltStat(attendedDateStrings, asOfDate) {
	const uniqueDateStrings = [...new Set(attendedDateStrings)];
	const attendedDates = uniqueDateStrings.map(parseIsoDate);
	const weeklyCounts = getWeeklyAttendanceCounts(attendedDates, asOfDate);
	const selectedCounts = [...weeklyCounts]
		.sort((a, b) => b - a)
		.slice(0, BEST_WEEKS_COUNT);

	const total = selectedCounts.reduce((sum, value) => sum + value, 0);
	const average = total / BEST_WEEKS_COUNT;

	return {
		weeklyCounts,
		selectedCounts,
		sumBestEight: total,
		currentWeekAttendance: weeklyCounts[0] ?? 0,
		average,
		isCompliant: average >= COMPLIANCE_THRESHOLD,
	};
}

function calculateCurrentMonthAttendance(attendedDateStrings, asOfDate) {
	const asOf = utcDateOnly(asOfDate);
	const year = asOf.getUTCFullYear();
	const month = asOf.getUTCMonth();
	const uniqueDateStrings = [...new Set(attendedDateStrings)];

	let attendanceCount = 0;
	for (const dateString of uniqueDateStrings) {
		const date = parseIsoDate(dateString);
		if (date > asOf) {
			continue;
		}

		if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month) {
			continue;
		}

		if (isWeekday(date)) {
			attendanceCount += 1;
		}
	}

	return attendanceCount;
}

function getCurrentMonthAttendanceDateStrings(attendedDateStrings, asOfDate) {
	const asOf = utcDateOnly(asOfDate);
	const year = asOf.getUTCFullYear();
	const month = asOf.getUTCMonth();
	const uniqueDateStrings = [...new Set(attendedDateStrings)];

	return uniqueDateStrings
		.filter((dateString) => {
			const date = parseIsoDate(dateString);
			if (date > asOf) {
				return false;
			}

			if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month) {
				return false;
			}

			return isWeekday(date);
		})
		.sort((left, right) => left.localeCompare(right));
}

function nextWeekday(date) {
	let cursor = utcDateOnly(date);
	while (!isWeekday(cursor)) {
		cursor = addDays(cursor, 1);
	}
	return cursor;
}

function getWfhStartDate(today, todayAttended) {
	// Rule:
	// - If today is attended, consecutive WFH counting starts from tomorrow.
	// - If today is not attended, consecutive WFH counting starts from today.
	const baseDate = todayAttended ? addDays(today, 1) : utcDateOnly(today);
	return nextWeekday(baseDate);
}

function computeMaximumConsecutiveWfhDays({
	attendedDateStrings,
	today,
	todayAttended,
}) {
	const scenarioDates = new Set(attendedDateStrings);
	const todayIso = formatIsoDate(today);

	if (todayAttended) {
		scenarioDates.add(todayIso);
	} else {
		scenarioDates.delete(todayIso);
	}

	const firstWfhDate = getWfhStartDate(today, todayAttended);

	let maxAllowed = 0;
	let weekdayWfhCount = 0;

	for (let dayOffset = 0; dayOffset < MAX_SIMULATION_DAYS; dayOffset += 1) {
		const cursor = addDays(firstWfhDate, dayOffset);
		if (!isWeekday(cursor)) {
			continue;
		}

		weekdayWfhCount += 1;
		const projected = calculateBeltStat([...scenarioDates], cursor);
		if (!projected.isCompliant) {
			break;
		}

		maxAllowed = weekdayWfhCount;
	}

	return maxAllowed;
}

async function fetchAttendedDateStrings() {
	const rows = await db
		.selectDistinct({ date: attendanceRecords.date })
		.from(attendanceRecords)
		.orderBy(asc(attendanceRecords.date));

	return rows.map((row) => row.date);
}

async function getBeltStats(now = new Date()) {
	const today = utcDateOnly(now);
	const todayIso = formatIsoDate(today);
	const attendedDateStrings = await fetchAttendedDateStrings();
	const attendedDateSet = new Set(attendedDateStrings);

	const current = calculateBeltStat(attendedDateStrings, today);
	const currentMonthAttendance = calculateCurrentMonthAttendance(
		attendedDateStrings,
		today,
	);
	const currentMonthAttendanceDates = getCurrentMonthAttendanceDateStrings(
		attendedDateStrings,
		today,
	);
	const maxIfTodayAttended = computeMaximumConsecutiveWfhDays({
		attendedDateStrings,
		today,
		todayAttended: true,
	});
	const maxIfTodayNotAttended = computeMaximumConsecutiveWfhDays({
		attendedDateStrings,
		today,
		todayAttended: false,
	});
	const wfhStartDateIfTodayAttended = formatIsoDate(
		getWfhStartDate(today, true),
	);
	const wfhStartDateIfTodayNotAttended = formatIsoDate(
		getWfhStartDate(today, false),
	);

	const todayWasAttended = attendedDateSet.has(todayIso);

	return {
		currentBeltStat: Number(current.average.toFixed(3)),
		sumBestEight: current.sumBestEight,
		currentMonthAttendance,
		currentMonthAttendanceDates,
		currentDate: todayIso,
		maximumConsecutiveWfhDays: todayWasAttended
			? maxIfTodayAttended
			: maxIfTodayNotAttended,
		nextDayAttendanceStatChange: maxIfTodayAttended - maxIfTodayNotAttended,
		metadata: {
			windowWeeks: TOTAL_WEEKS,
			bestWeeksUsed: BEST_WEEKS_COUNT,
			currentWeekIncluded: true,
			currentWeekAttendance: current.currentWeekAttendance,
			bestEightBreakdown: current.selectedCounts,
			trailingTwelveBreakdown: current.weeklyCounts,
			wfhStartDateIfTodayAttended,
			wfhStartDateIfTodayNotAttended,
			complianceThreshold: COMPLIANCE_THRESHOLD,
			todayWasAttended,
		},
	};
}

module.exports = {
	getBeltStats,
};
