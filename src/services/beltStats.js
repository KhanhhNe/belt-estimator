const { and, asc, eq, gte, lte } = require("drizzle-orm");
const { attendanceRecords } = require("../db/schema");

const TOTAL_WEEKS = 12;
const COMPLIANCE_THRESHOLD = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * @typedef {object} WeekBounds
 * @property {Date} today
 * @property {Date} currentWeekStart
 * @property {Date} currentWeekEnd
 */

/**
 * @typedef {object} BeltStatsResult
 * @property {string[]} attendedDateStrings
 * @property {number} currentBeltStat
 * @property {string} currentDate
 * @property {number} maximumConsecutiveWfhDays
 * @property {number} nextDayAttendanceStatChange
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
 * @param {Date} date
 * @returns {Date}
 */
function startOfWeek(date) {
	if (date.getUTCDay() === 0) {
		// Sunday should be treated as the end of the week, so subtract 6 days to get to Monday.
		const res = addDays(date, -6);
		res.setUTCHours(0, 0, 0, 0);
		return res;
	}

	// For other days, subtract the appropriate number of days to get to Monday.
	const res = addDays(date, -(date.getUTCDay() - 1));
	res.setUTCHours(0, 0, 0, 0);
	return res;
}

/**
 * @typedef {object} BeltStatFromWeeksResult
 * @property {number} belt
 * @property {number} totalWeeks
 */

/**
 *
 * @param {number[]} weeklyCounts
 * @returns {BeltStatFromWeeksResult}
 */
function calculateStatsFromWeeks(
	weeklyCounts,
	from = 0,
	to = weeklyCounts.length,
) {
	const beltVals = Array(8).fill(0);
	for (let i = from; i < to; i++) {
		const count = weeklyCounts[i] ?? 0;
		if (count > 0) {
			beltVals[count] += 1;
		}
	}

	let weekCount = 8,
		ind = beltVals.length - 1,
		totalWeeks = 0,
		sumBestEight = 0;
	while (weekCount > 0 && ind > 0) {
		if (beltVals[ind] === 0) {
			ind -= 1;
			continue;
		}

		const deduct = Math.min(weekCount, beltVals[ind]);
		sumBestEight += deduct * ind;

		weekCount -= deduct;
		ind -= 1;
		totalWeeks += deduct;
	}

	return {
		belt: sumBestEight / totalWeeks,
		totalWeeks,
	};
}

/**
 *
 * @param {number[]} calcWeeks
 * @returns {number}
 */
function calculateAdditionalWfhDays(calcWeeks) {
	const minDays = COMPLIANCE_THRESHOLD * 8;

	let ind = calcWeeks.length - 1,
		importantWeeksSum = 0,
		importantWeeksCount = 0;
	while (ind >= 0 && importantWeeksSum < minDays - 5) {
		importantWeeksSum += calcWeeks[ind];
		importantWeeksCount += 1;
		ind -= 1;
	}

	const fullWeeks = TOTAL_WEEKS - (importantWeeksCount + 1);
	const remainingDaysForLastWeek = 5 - (minDays - importantWeeksSum);
	const result = fullWeeks * 5 + remainingDaysForLastWeek;

	console.log({
		importantWeeksCount,
		importantWeeksSum,
		fullWeeks,
		remainingDaysForLastWeek,
		result,
	});

	return result;
}

/**
 * @param {string[]} dates
 * @returns {BeltStatsResult}
 */
function calculateBeltStats(dates) {
	const time = performance.now();

	/** @type {BeltStatsResult} */
	const result = {
		attendedDateStrings: [],
		currentBeltStat: 0,
		currentDate: "",
		maximumConsecutiveWfhDays: 0,
		nextDayAttendanceStatChange: 0,
	};

	const now = new Date();
	const today = utcPlus7DateOnly(now);
	let todayAttended = false;

	result.currentDate = formatIsoDate(today);

	const firstDate = addDays(startOfWeek(today), -(TOTAL_WEEKS - 1) * 7);

	const calcWeeks = Array(TOTAL_WEEKS).fill(0); // Week attendance counts
	const calcDates = Array(TOTAL_WEEKS * 7).fill(0); // Daily attendance flags

	for (const dateString of dates) {
		const date = parseIsoDate(dateString);
		const dateInd = Math.floor(
			(date.getTime() - firstDate.getTime()) / MS_PER_DAY,
		);
		const weekInd = Math.floor(dateInd / 7);

		if (dateInd < 0 || dateInd >= calcDates.length) {
			continue;
		}
		if (calcDates[dateInd]) {
			continue;
		}

		result.attendedDateStrings.push(dateString);

		calcDates[dateInd] = 1;
		calcWeeks[weekInd] += 1;
		if (date.getTime() === today.getTime()) {
			todayAttended = true;
		}
	}

	result.currentBeltStat = calculateStatsFromWeeks(calcWeeks).belt;

	let remainingDaysThisWeek = 0;
	if (1 <= today.getUTCDay() && today.getUTCDay() <= 5) {
		remainingDaysThisWeek = 5 - today.getUTCDay();
	}

	result.maximumConsecutiveWfhDays =
		calculateAdditionalWfhDays(calcWeeks) + remainingDaysThisWeek;

	const weeksWithoutToday = [...calcWeeks];
	if (todayAttended) {
		weeksWithoutToday[weeksWithoutToday.length - 1] -= 1;
	} else {
		calcWeeks[calcWeeks.length - 1] += 1;
	}
	const wfhWithout = calculateAdditionalWfhDays(weeksWithoutToday);
	const wfhWith = calculateAdditionalWfhDays(calcWeeks);
	result.nextDayAttendanceStatChange = wfhWith - wfhWithout;

	console.log(
		"Time taken for calculateBeltStats:",
		(performance.now() - time).toFixed(3),
		"ms",
	);

	return result;
}

module.exports = {
	calculateBeltStats,
	fetchAttendedDateStrings,
};
