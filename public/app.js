let attendanceUpdateInFlight = false;
let baselineAttendedDateSet = new Set();
let workingAttendedDateSet = new Set();
let latestStatsPayload = null;
let viewedMonthDateString = null;

async function loadStats() {
	const statsGrid = document.getElementById("stats-grid");

	try {
		const response = await fetch("/api/stats");
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}

		const stats = await response.json();
		const baselineDates = stats.attendedDateStrings ?? [];
		baselineAttendedDateSet = new Set(baselineDates);
		workingAttendedDateSet = new Set(baselineDates);
		latestStatsPayload = stats;
		if (!viewedMonthDateString) {
			viewedMonthDateString = getMonthStartDateString(stats.currentDate);
		}
		renderStats(statsGrid, stats);
	} catch (error) {
		statsGrid.innerHTML = `
      <article class="stat-card stat-card-primary">
        <p class="stat-label">Unable to load stats</p>
        <p class="stat-value">Please retry</p>
        <p class="stat-description">Backend error while fetching /api/stats: ${String(error.message)}</p>
      </article>
    `;
	}
}

function toSignedNumber(value) {
	if (value > 0) {
		return `+${value}`;
	}

	return `${value}`;
}

function formatBeltStatValue(value) {
	return value.toFixed(3).replace(/\.?0+$/, "");
}

function parseIsoDate(dateString) {
	const [year, month, day] = dateString.split("-").map(Number);
	return new Date(Date.UTC(year, month - 1, day));
}

function formatIsoDate(date) {
	return date.toISOString().slice(0, 10);
}

function getMonthStartDateString(dateString) {
	const date = parseIsoDate(dateString);
	return formatIsoDate(
		new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)),
	);
}

function shiftMonthDateString(monthDateString, monthOffset) {
	const baseDate = parseIsoDate(monthDateString);
	return formatIsoDate(
		new Date(
			Date.UTC(
				baseDate.getUTCFullYear(),
				baseDate.getUTCMonth() + monthOffset,
				1,
			),
		),
	);
}

function formatMonthLabel(dateString) {
	const date = parseIsoDate(dateString);
	return new Intl.DateTimeFormat("en-US", {
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	}).format(date);
}

function buildMonthCalendarCells(
	monthDateString,
	todayDateString,
	attendedDateStrings,
) {
	const monthDate = parseIsoDate(monthDateString);
	const year = monthDate.getUTCFullYear();
	const month = monthDate.getUTCMonth();
	const firstOfMonth = new Date(Date.UTC(year, month, 1));
	const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

	const mondayStartIndex = (firstOfMonth.getUTCDay() + 6) % 7;
	const cells = [];
	const attendedSet = new Set(attendedDateStrings || []);

	for (let pad = 0; pad < mondayStartIndex; pad += 1) {
		const leadDate = new Date(
			Date.UTC(year, month, pad - mondayStartIndex + 1),
		);
		const leadIso = formatIsoDate(leadDate);
		const leadDay = leadDate.getUTCDate();
		const isAttended = attendedSet.has(leadIso);
		const isUserUpdatedAttended =
			isAttended && !baselineAttendedDateSet.has(leadIso);
		const isToday = leadIso === todayDateString;

		let className = "calendar-cell calendar-cell-outside-month";
		if (isAttended) {
			className += " calendar-cell-attended";
		}
		if (isUserUpdatedAttended) {
			className += " calendar-cell-attended-user";
		}
		if (isToday) {
			className += " calendar-cell-today";
		}

		cells.push(
			`<div class="${className} calendar-cell-clickable" data-date="${leadIso}" role="button" tabindex="0" aria-pressed="${isAttended}" title="${isAttended ? "Marked attended (temporary). Click to unmark." : "Not marked attended. Click to mark temporarily."}"><span class="calendar-day-number">${leadDay}</span></div>`,
		);
	}

	for (let day = 1; day <= daysInMonth; day += 1) {
		const date = new Date(Date.UTC(year, month, day));
		const iso = date.toISOString().slice(0, 10);

		const isAttended = attendedSet.has(iso);
		const isUserUpdatedAttended =
			isAttended && !baselineAttendedDateSet.has(iso);
		const isToday = iso === todayDateString;

		let className = "calendar-cell";
		if (isAttended) {
			className += " calendar-cell-attended";
		}
		if (isUserUpdatedAttended) {
			className += " calendar-cell-attended-user";
		}
		if (isToday) {
			className += " calendar-cell-today";
		}

		cells.push(
			`<div class="${className} calendar-cell-clickable" data-date="${iso}" role="button" tabindex="0" aria-pressed="${isAttended}" title="${isAttended ? "Marked attended (temporary). Click to unmark." : "Not marked attended. Click to mark temporarily."}"><span class="calendar-day-number">${day}</span></div>`,
		);
	}

	const trailingCellCount = (7 - (cells.length % 7)) % 7;
	for (
		let trailingDay = 1;
		trailingDay <= trailingCellCount;
		trailingDay += 1
	) {
		const trailingDate = new Date(Date.UTC(year, month + 1, trailingDay));
		const trailingIso = formatIsoDate(trailingDate);
		const isAttended = attendedSet.has(trailingIso);
		const isUserUpdatedAttended =
			isAttended && !baselineAttendedDateSet.has(trailingIso);
		const isToday = trailingIso === todayDateString;

		let className = "calendar-cell calendar-cell-outside-month";
		if (isAttended) {
			className += " calendar-cell-attended";
		}
		if (isUserUpdatedAttended) {
			className += " calendar-cell-attended-user";
		}
		if (isToday) {
			className += " calendar-cell-today";
		}

		cells.push(
			`<div class="${className} calendar-cell-clickable" data-date="${trailingIso}" role="button" tabindex="0" aria-pressed="${isAttended}" title="${isAttended ? "Marked attended (temporary). Click to unmark." : "Not marked attended. Click to mark temporarily."}"><span class="calendar-day-number">${trailingDay}</span></div>`,
		);
	}

	return cells.join("");
}

function renderStats(target, payload) {
	const currentBeltStat = Number(payload.currentBeltStat ?? 0);
	const attendedDateStrings = payload.attendedDateStrings ?? [];
	const currentDate = payload.currentDate;
	const maximumConsecutiveWfhDays = Number(
		payload.maximumConsecutiveWfhDays ?? 0,
	);
	const nextDayAttendanceStatChange = Number(
		payload.nextDayAttendanceStatChange ?? 0,
	);

	const complianceBadgeClass =
		currentBeltStat >= 3
			? "stat-badge stat-badge-ok"
			: "stat-badge stat-badge-bad";
	const complianceBadgeText =
		currentBeltStat >= 3 ? "Compliant (>= 3.0)" : "At risk (< 3.0)";

	const wfhBadgeClass =
		maximumConsecutiveWfhDays >= 3
			? "stat-badge stat-badge-ok"
			: "stat-badge stat-badge-warn";
	const wfhBadgeText = `${maximumConsecutiveWfhDays} weekday(s) can be WFH consecutively`;

	const deltaBadgeClass =
		nextDayAttendanceStatChange > 0
			? "stat-badge stat-badge-ok"
			: nextDayAttendanceStatChange < 0
				? "stat-badge stat-badge-bad"
				: "stat-badge stat-badge-warn";

	const deltaBadgeText =
		nextDayAttendanceStatChange > 0
			? "Attending today improves runway"
			: nextDayAttendanceStatChange < 0
				? "Missing today reduces runway"
				: "No change either way";

	const calendarCellsMarkup = buildMonthCalendarCells(
		viewedMonthDateString,
		currentDate,
		attendedDateStrings,
	);
	const monthLabel = formatMonthLabel(viewedMonthDateString);
	const weekdayHeadersMarkup = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
		.map(
			(weekday) =>
				`<div class="calendar-weekday" aria-hidden="true">${weekday}</div>`,
		)
		.join("");

	target.innerHTML = `
		<section class="dashboard-layout">
			<article class="calendar-panel">
				<div class="calendar-header-row">
					<div class="calendar-month-nav" role="group" aria-label="Calendar month navigation">
						<button class="calendar-month-nav-button" type="button" data-month-offset="-1" aria-label="Show previous month"><span class="calendar-month-nav-icon" aria-hidden="true">&#10094;</span></button>
						<p class="calendar-month-label">${monthLabel}</p>
						<button class="calendar-month-nav-button" type="button" data-month-offset="1" aria-label="Show next month"><span class="calendar-month-nav-icon" aria-hidden="true">&#10095;</span></button>
					</div>
				</div>
				<div class="calendar-matrix" aria-label="Attendance calendar for ${monthLabel}">
					${weekdayHeadersMarkup}
					${calendarCellsMarkup}
				</div>
				<div class="calendar-legend-row">
					<span class="calendar-legend-item"><span class="calendar-legend-dot calendar-legend-dot-attended"></span>Attended</span>
					<span class="calendar-legend-item"><span class="calendar-legend-dot calendar-legend-dot-attended-user"></span>User updated</span>
					<span class="calendar-legend-item"><span class="calendar-legend-dot calendar-legend-dot-today"></span>Today</span>
				</div>
				<p class="calendar-usage-hint">Tip: Click any date to preview stat changes.</p>
			</article>

			<article class="stat-panel">
				<div class="compact-stats-grid">
					<div class="compact-stat-tile">
						<p class="stat-label">Max Consecutive WFH</p>
						<p class="stat-value stat-value-compact" style="color: #ff468c;">${maximumConsecutiveWfhDays}</p>
						<span class="${wfhBadgeClass}">${wfhBadgeText}</span>
					</div>
					<div class="compact-stat-tile">
						<p class="stat-label">BELT Stat</p>
						<p class="stat-value stat-value-compact">${formatBeltStatValue(currentBeltStat)}</p>
						<span class="${complianceBadgeClass}">${complianceBadgeText}</span>
					</div>
					<div class="compact-stat-tile">
						<p class="stat-label">Today Attendance Delta</p>
						<p class="stat-value stat-value-compact">${toSignedNumber(nextDayAttendanceStatChange)}</p>
						<span class="${deltaBadgeClass}">${deltaBadgeText}</span>
					</div>
				</div>
			</article>
		</section>
	`;
}

async function recalculatePreviewStats(attendedDateStrings) {
	const response = await fetch("/api/stats/preview", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ attendedDateStrings }),
	});

	if (!response.ok) {
		throw new Error(`HTTP ${response.status}`);
	}

	return response.json();
}

async function handleAttendanceToggleCell(calendarCell) {
	if (attendanceUpdateInFlight) {
		return;
	}

	const dateString = calendarCell.dataset.date;
	if (!dateString) {
		return;
	}

	const shouldMarkAttended = !workingAttendedDateSet.has(dateString);
	if (shouldMarkAttended) {
		workingAttendedDateSet.add(dateString);
	} else {
		workingAttendedDateSet.delete(dateString);
	}

	attendanceUpdateInFlight = true;
	calendarCell.classList.add("calendar-cell-updating");

	try {
		const previewStats = await recalculatePreviewStats([
			...workingAttendedDateSet,
		]);
		const statsGrid = document.getElementById("stats-grid");
		latestStatsPayload = previewStats;
		renderStats(statsGrid, previewStats);
	} catch (error) {
		if (shouldMarkAttended) {
			workingAttendedDateSet.delete(dateString);
		} else {
			workingAttendedDateSet.add(dateString);
		}
		console.error("Failed to toggle attendance", error);
	} finally {
		attendanceUpdateInFlight = false;
		calendarCell.classList.remove("calendar-cell-updating");
	}
}

function registerCalendarInteractions() {
	const statsGrid = document.getElementById("stats-grid");

	function changeViewedMonth(monthOffset) {
		if (!latestStatsPayload || !viewedMonthDateString) {
			return;
		}

		viewedMonthDateString = shiftMonthDateString(
			viewedMonthDateString,
			monthOffset,
		);
		renderStats(statsGrid, latestStatsPayload);
	}

	statsGrid.addEventListener("click", (event) => {
		if (!(event.target instanceof Element)) {
			return;
		}

		const monthNavButton = event.target.closest(".calendar-month-nav-button");
		if (monthNavButton) {
			const monthOffset = Number(
				monthNavButton.getAttribute("data-month-offset"),
			);
			if (Number.isInteger(monthOffset)) {
				changeViewedMonth(monthOffset);
			}
			return;
		}

		const calendarCell = event.target.closest(".calendar-cell-clickable");
		if (!calendarCell) {
			return;
		}

		handleAttendanceToggleCell(calendarCell);
	});

	statsGrid.addEventListener("keydown", (event) => {
		if (event.key !== "Enter" && event.key !== " ") {
			return;
		}

		if (!(event.target instanceof Element)) {
			return;
		}

		const calendarCell = event.target.closest(".calendar-cell-clickable");
		if (!calendarCell) {
			return;
		}

		event.preventDefault();
		handleAttendanceToggleCell(calendarCell);
	});
}

registerCalendarInteractions();
loadStats();
