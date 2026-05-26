async function loadStats() {
	const statsGrid = document.getElementById("stats-grid");

	try {
		const response = await fetch("/api/stats");
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}

		const stats = await response.json();
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

function parseIsoDate(dateString) {
	const [year, month, day] = dateString.split("-").map(Number);
	return new Date(Date.UTC(year, month - 1, day));
}

function formatMonthLabel(dateString) {
	const date = parseIsoDate(dateString);
	return new Intl.DateTimeFormat("en-US", {
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	}).format(date);
}

function buildMonthCalendarCells(currentDateString, attendedDateStrings) {
	const currentDate = parseIsoDate(currentDateString);
	const year = currentDate.getUTCFullYear();
	const month = currentDate.getUTCMonth();
	const firstOfMonth = new Date(Date.UTC(year, month, 1));
	const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

	const mondayStartIndex = (firstOfMonth.getUTCDay() + 6) % 7;
	const cells = [];
	const attendedSet = new Set(attendedDateStrings || []);

	for (let pad = 0; pad < mondayStartIndex; pad += 1) {
		cells.push(
			'<div class="calendar-cell calendar-cell-empty" aria-hidden="true"></div>',
		);
	}

	for (let day = 1; day <= daysInMonth; day += 1) {
		const date = new Date(Date.UTC(year, month, day));
		const iso = date.toISOString().slice(0, 10);

		const isAttended = attendedSet.has(iso);
		const isToday = iso === currentDateString;

		let className = "calendar-cell";
		if (isAttended) {
			className += " calendar-cell-attended";
		}
		if (isToday) {
			className += " calendar-cell-today";
		}

		cells.push(
			`<div class="${className}" title="${iso}"><span class="calendar-day-number">${day}</span></div>`,
		);
	}

	return cells.join("");
}

function renderStats(target, payload) {
	const currentBeltStat = Number(payload.currentBeltStat ?? 0);
	const sumBestEight = Number(payload.sumBestEight ?? 0);
	const currentMonthAttendanceDates = payload.currentMonthAttendanceDates ?? [];
	const currentDate = payload.currentDate;
	const todayWasAttended = Boolean(payload.metadata?.todayWasAttended);
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
	const wfhBadgeText = `${maximumConsecutiveWfhDays} weekday(s) can be WFH in a row`;

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

	const wfhStartDate = todayWasAttended
		? payload.metadata?.wfhStartDateIfTodayAttended
		: payload.metadata?.wfhStartDateIfTodayNotAttended;
	const wfhStartLabel = todayWasAttended ? "Tomorrow" : "Today";
	const wfhStartText = wfhStartDate
		? `Starts counting from ${wfhStartLabel} (${wfhStartDate})`
		: `Starts counting from ${wfhStartLabel}`;
	const deltaRuleText = todayWasAttended
		? "For delta comparison: today is excluded in the attended scenario and included only in the not-attended scenario."
		: "For delta comparison: today is included in the not-attended scenario and excluded in the attended scenario.";

	const calendarCellsMarkup = buildMonthCalendarCells(
		currentDate,
		currentMonthAttendanceDates,
	);
	const monthLabel = formatMonthLabel(currentDate);
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
					<p class="calendar-month-label">${monthLabel}</p>
					<div class="calendar-legend-row">
						<span class="calendar-legend-item"><span class="calendar-legend-dot calendar-legend-dot-attended"></span>Attended</span>
						<span class="calendar-legend-item"><span class="calendar-legend-dot calendar-legend-dot-today"></span>Today</span>
					</div>
				</div>
				<div class="calendar-matrix" aria-label="Current month attendance calendar">
					${weekdayHeadersMarkup}
					${calendarCellsMarkup}
				</div>
			</article>

			<article class="stat-panel">
				<div class="compact-stats-grid">
					<div class="compact-stat-tile">
						<p class="stat-label">BELT Stat</p>
						<p class="stat-value stat-value-compact">${currentBeltStat.toFixed(3)}</p>
						<p class="stat-debug-line">sumBestEight: ${sumBestEight}</p>
						<span class="${complianceBadgeClass}">${complianceBadgeText}</span>
					</div>
					<div class="compact-stat-tile">
						<p class="stat-label">Max Consecutive WFH</p>
						<p class="stat-value stat-value-compact">${maximumConsecutiveWfhDays}</p>
						<p class="stat-debug-line">${wfhStartText}</p>
						<span class="${wfhBadgeClass}">${wfhBadgeText}</span>
					</div>
					<div class="compact-stat-tile">
						<p class="stat-label">Today Attendance Delta</p>
						<p class="stat-value stat-value-compact">${toSignedNumber(nextDayAttendanceStatChange)}</p>
						<p class="stat-debug-line">${deltaRuleText}</p>
						<span class="${deltaBadgeClass}">${deltaBadgeText}</span>
					</div>
				</div>
			</article>
		</section>
	`;
}

loadStats();
