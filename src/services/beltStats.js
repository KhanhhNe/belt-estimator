const { and, asc, eq, gte, lte } = require("drizzle-orm");
const { attendanceRecords } = require("../db/schema");

const TOTAL_WEEKS = 12;
const BEST_WEEKS_COUNT = 8;
const COMPLIANCE_THRESHOLD = 3;
const MAX_SIMULATION_DAYS = 365;

/**
 * @typedef {object} WeekBounds
 * @property {Date} today
 * @property {Date} currentWeekStart
 * @property {Date} currentWeekEnd
 */

/**
 * @typedef {object} BeltWeekStat
 * @property {number[]} weeklyCounts
 * @property {number[]} selectedCounts
 * @property {number} sumBestEight
 * @property {number} currentWeekAttendance
 * @property {number} average
 * @property {boolean} isCompliant
 */

/**
 * @typedef {object} BeltStatsMetadata
 * @property {number} windowWeeks
 * @property {number} bestWeeksUsed
 * @property {boolean} currentWeekIncluded
 * @property {string} beltStatAsOfDate
 * @property {number} currentWeekAttendance
 * @property {number[]} bestEightBreakdown
 * @property {number[]} trailingTwelveBreakdown
 * @property {string} wfhStartDateIfTodayAttended
 * @property {string} wfhStartDateIfTodayNotAttended
 * @property {string} deltaComparisonStartDate
 * @property {number} complianceThreshold
 * @property {boolean} todayWasAttended
 */

/**
 * @typedef {object} BeltStatsResult
 * @property {string[]} attendedDateStrings
 * @property {number} currentBeltStat
 * @property {number} sumBestEight
 * @property {number} currentMonthAttendance
 * @property {string[]} currentMonthAttendanceDates
 * @property {string} currentDate
 * @property {number} maximumConsecutiveWfhDays
 * @property {number} nextDayAttendanceStatChange
 * @property {BeltStatsMetadata} metadata
 */

/**
 * @typedef {object} WfhSimulationOptions
 * @property {string[]} attendedDateStrings
 * @property {Date} today
 * @property {boolean} todayAttended
 * @property {Date | null} [startDateOverride]
 */

/**
 * @typedef {object} AttendanceDateRow
 * @property {string} date
 */

/**
 * @param {string} dateString
 * @returns {Date}
 */
function parseIsoDate(dateString) {
	const [year, month, day] = dateString.split("-").map(Number);
	return new Date(Date.UTC(year, month - 1, day));
}

/**
 * @param {Date} date
 * @returns {string}
 */
function formatIsoDate(date) {
	return date.toISOString().slice(0, 10);
}

function utcDateOnly(date) {
	return new Date(
		Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
	);
}

function utcPlus7DateOnly(date) {
	const shifted = new Date(date.getTime() + 7 * 60 * 60 * 1000);
	return new Date(
		Date.UTC(
			shifted.getUTCFullYear(),
			shifted.getUTCMonth(),
			shifted.getUTCDate(),
		),
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

/**
 * @param {Date} [now]
 * @returns {WeekBounds}
 */
function getUtcPlus7WeekBounds(now = new Date()) {
	const today = utcPlus7DateOnly(now);
	const currentWeekStart = startOfWeekMonday(today);
	const currentWeekEnd = addDays(currentWeekStart, 6);

	return {
		today,
		currentWeekStart,
		currentWeekEnd,
	};
}

function getFetchWindowStartDate(now) {
	const { currentWeekStart } = getUtcPlus7WeekBounds(now);
	return addDays(currentWeekStart, -(TOTAL_WEEKS - 1) * 7);
}

function getFetchWindowEndDate(now) {
	const { currentWeekEnd } = getUtcPlus7WeekBounds(now);
	return currentWeekEnd;
}

/**
 * @param {Date[]} attendedDates
 * @param {Date} asOfDate
 * @returns {number[]}
 */
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

/**
 * @param {string[]} attendedDateStrings
 * @param {Date} asOfDate
 * @returns {BeltWeekStat}
 */
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

/**
 * @param {string[]} attendedDateStrings
 * @param {Date} asOfDate
 * @returns {number}
 */
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

/**
 * @param {string[]} attendedDateStrings
 * @param {Date} asOfDate
 * @returns {string[]}
 */
function getCurrentMonthAttendanceDateStrings(attendedDateStrings, asOfDate) {
	const asOf = utcDateOnly(asOfDate);
	const year = asOf.getUTCFullYear();
	const month = asOf.getUTCMonth();
	const uniqueDateStrings = [...new Set(attendedDateStrings)];

	return uniqueDateStrings
		.filter((dateString) => {
			const date = parseIsoDate(dateString);
			if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month) {
				return false;
			}

			return true;
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

/**
 * @param {WfhSimulationOptions} options
 * @returns {number}
 */
function computeMaximumConsecutiveWfhDays({
	attendedDateStrings,
	today,
	todayAttended,
	startDateOverride = null,
}) {
	const scenarioDates = new Set(attendedDateStrings);
	const todayIso = formatIsoDate(today);

	if (todayAttended) {
		scenarioDates.add(todayIso);
	} else {
		scenarioDates.delete(todayIso);
	}

	const firstWfhDate = startDateOverride
		? nextWeekday(startDateOverride)
		: getWfhStartDate(today, todayAttended);

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

/**
 * @param {import("drizzle-orm/libsql").LibSQLDatabase} db
 * @param {number} userId
 * @param {Date} [now]
 * @returns {Promise<string[]>}
 */
async function fetchAttendedDateStrings(db, userId, now = new Date()) {
	const windowStartDate = formatIsoDate(getFetchWindowStartDate(now));
	const windowEndDate = formatIsoDate(getFetchWindowEndDate(now));

	const rows = await db
		.selectDistinct({ date: attendanceRecords.date })
		.from(attendanceRecords)
		.where(
			and(
				eq(attendanceRecords.userId, userId),
				gte(attendanceRecords.date, windowStartDate),
				lte(attendanceRecords.date, windowEndDate),
			),
		)
		.orderBy(asc(attendanceRecords.date));

	return rows.map(/** @param {AttendanceDateRow} row */ (row) => row.date);
}

/**
 * @param {string[]} dates
 * @returns {BeltStatsResult}
 */
function calculateBeltStats(dates) {
	const now = new Date();
	const today = utcPlus7DateOnly(now);
	const todayIso = formatIsoDate(today);
	const normalizedAttendedDateStrings = [...new Set(dates ?? [])].sort(
		(left, right) => left.localeCompare(right),
	);
	const attendedDateSet = new Set(normalizedAttendedDateStrings);
	const latestSelectedIso =
		normalizedAttendedDateStrings[normalizedAttendedDateStrings.length - 1] ??
		todayIso;
	const latestSelectedDate = parseIsoDate(latestSelectedIso);
	const beltStatAsOfDate =
		latestSelectedDate > today ? latestSelectedDate : today;

	const current = calculateBeltStat(
		normalizedAttendedDateStrings,
		beltStatAsOfDate,
	);
	const currentMonthAttendance = calculateCurrentMonthAttendance(
		normalizedAttendedDateStrings,
		today,
	);
	const currentMonthAttendanceDates = getCurrentMonthAttendanceDateStrings(
		normalizedAttendedDateStrings,
		today,
	);
	const maxIfTodayAttended = computeMaximumConsecutiveWfhDays({
		attendedDateStrings: normalizedAttendedDateStrings,
		today,
		todayAttended: true,
	});
	const maxIfTodayNotAttended = computeMaximumConsecutiveWfhDays({
		attendedDateStrings: normalizedAttendedDateStrings,
		today,
		todayAttended: false,
	});
	const deltaComparisonStartDate = nextWeekday(addDays(today, 1));
	const deltaIfTodayAttended = computeMaximumConsecutiveWfhDays({
		attendedDateStrings: normalizedAttendedDateStrings,
		today,
		todayAttended: true,
		startDateOverride: deltaComparisonStartDate,
	});
	const deltaIfTodayNotAttended = computeMaximumConsecutiveWfhDays({
		attendedDateStrings: normalizedAttendedDateStrings,
		today,
		todayAttended: false,
		startDateOverride: deltaComparisonStartDate,
	});
	const wfhStartDateIfTodayAttended = formatIsoDate(
		getWfhStartDate(today, true),
	);
	const wfhStartDateIfTodayNotAttended = formatIsoDate(
		getWfhStartDate(today, false),
	);

	const todayWasAttended = attendedDateSet.has(todayIso);

	return {
		attendedDateStrings: normalizedAttendedDateStrings,
		currentBeltStat: Number(current.average.toFixed(3)),
		sumBestEight: current.sumBestEight,
		currentMonthAttendance,
		currentMonthAttendanceDates,
		currentDate: todayIso,
		maximumConsecutiveWfhDays: todayWasAttended
			? maxIfTodayAttended
			: maxIfTodayNotAttended,
		nextDayAttendanceStatChange: deltaIfTodayAttended - deltaIfTodayNotAttended,
		metadata: {
			windowWeeks: TOTAL_WEEKS,
			bestWeeksUsed: BEST_WEEKS_COUNT,
			currentWeekIncluded: true,
			beltStatAsOfDate: formatIsoDate(beltStatAsOfDate),
			currentWeekAttendance: current.currentWeekAttendance,
			bestEightBreakdown: current.selectedCounts,
			trailingTwelveBreakdown: current.weeklyCounts,
			wfhStartDateIfTodayAttended,
			wfhStartDateIfTodayNotAttended,
			deltaComparisonStartDate: formatIsoDate(deltaComparisonStartDate),
			complianceThreshold: COMPLIANCE_THRESHOLD,
			todayWasAttended,
		},
	};
}

module.exports = {
	calculateBeltStats,
	fetchAttendedDateStrings,
};
