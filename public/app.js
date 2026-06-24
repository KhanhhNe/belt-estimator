let attendanceUpdateInFlight = false;
let baselineAttendedDateSet = new Set();
let workingAttendedDateSet = new Set();
let latestStatsPayload = null;
let viewedMonthDateString = null;
let currentUser = null;
let currentUserLoading = false;
let authPanelMessage = "";
let authViewMode = "login";
let forgotPasswordResult = null;
let forgotPasswordDraft = null;
let uniqueCodeVisible = false;
let adminUsers = [];
let selectedAdminUserId = null;
let adminUsersLoading = false;
let adminImpersonationInFlight = false;
let adminPanelMessage = "";
let attendancePreviewDebounceTimer = null;
let attendancePreviewVersion = 0;
let attendancePreviewRequestId = 0;
let monthAttendanceInFlight = false;
let monthAttendanceLoadRequestId = 0;
const monthAttendanceCache = new Map();
const pendingPersistenceOperations = new Map();

const ATTENDANCE_PREVIEW_DEBOUNCE_MS = 300;

function getUtcPlus7DateString(now = new Date()) {
	const localTimeInUtcPlus7 = new Date(now.getTime() + 7 * 60 * 60 * 1000);
	return localTimeInUtcPlus7.toISOString().slice(0, 10);
}

function escapeHtml(value) {
	return `${value}`
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function getInstallerScriptUrl() {
	return `${window.location.origin}/belt-estimator-installer.ps1`;
}

function getInstallerOneLiner(uniqueCode) {
	const scriptUrl = getInstallerScriptUrl();
	return `irm '${scriptUrl}?code=${uniqueCode}' | iex`;
}

function getMaskedInstallerOneLiner() {
	return getInstallerOneLiner("******");
}

function setStatsLocked(isLocked) {
	const statsShell = document.getElementById("stats-shell");
	if (!statsShell) {
		return;
	}

	if (isLocked) {
		statsShell.classList.add("stats-shell-locked");
	} else {
		statsShell.classList.remove("stats-shell-locked");
	}
}

function resetDashboardData() {
	baselineAttendedDateSet = new Set();
	workingAttendedDateSet = new Set();
	latestStatsPayload = null;
	viewedMonthDateString = null;
	monthAttendanceCache.clear();
	monthAttendanceLoadRequestId += 1;
	monthAttendanceInFlight = false;
}

function getInitialViewedMonthDateString() {
	return getMonthStartDateString(getUtcPlus7DateString());
}

function renderCurrentStatsPreview() {
	const statsGrid = document.getElementById("stats-grid");
	if (!statsGrid || !latestStatsPayload) {
		return;
	}

	renderStats(statsGrid, {
		...latestStatsPayload,
		attendedDateStrings: getCalendarAttendedDateStringsForViewedMonth(),
	});
}

function syncViewedMonthAttendance(attendedDateStrings) {
	const syncedDates = new Set(attendedDateStrings ?? []);
	baselineAttendedDateSet = new Set(syncedDates);
	workingAttendedDateSet = new Set(syncedDates);
}

function getPendingPersistenceOperation(dateString) {
	return pendingPersistenceOperations.get(dateString) ?? null;
}

function getPersistenceInFlight() {
	return pendingPersistenceOperations.size > 0;
}

function renderAuthUi() {
	const greetingElement = document.getElementById("auth-greeting");
	const actionBar = document.getElementById("auth-action-bar");
	const authPanel = document.getElementById("auth-panel");
	const uniqueCodeFooter = document.getElementById("unique-code-footer");

	if (!greetingElement || !actionBar || !authPanel || !uniqueCodeFooter) {
		return;
	}

	if (currentUser) {
		const adminUserOptionsMarkup = adminUsers
			.map((user) => {
				const optionLabel = user.isAdmin
					? `${user.username} (admin)`
					: user.username;
				return `<option value="${user.id}" ${String(user.id) === String(selectedAdminUserId) ? "selected" : ""}>${escapeHtml(optionLabel)}</option>`;
			})
			.join("");
		const adminSectionMarkup = currentUser.isAdmin
			? `<div class="auth-note auth-note-warning admin-impersonation-card">
				<p class="auth-note-title">Admin: Login As Another User</p>
				<p class="auth-note-text">Select a user, then switch this browser session to that account.</p>
				<div class="auth-inline-actions admin-impersonation-row">
					<select id="admin-user-select" class="auth-input admin-user-select" ${adminUsersLoading || adminImpersonationInFlight ? "disabled" : ""}>
						${adminUserOptionsMarkup}
					</select>
					<button type="button" class="auth-button auth-button-primary" data-auth-action="admin-impersonate" ${adminUsersLoading || adminImpersonationInFlight || !selectedAdminUserId ? "disabled" : ""}>${adminImpersonationInFlight ? "Switching..." : "Login As User"}</button>
				</div>
				${adminUsersLoading ? '<p class="auth-inline-message">Loading users...</p>' : ""}
				${adminPanelMessage ? `<p class="auth-inline-message">${escapeHtml(adminPanelMessage)}</p>` : ""}
			</div>`
			: "";

		greetingElement.textContent = `Hello ${currentUser.username} on home`;
		actionBar.innerHTML = `
			<button type="button" class="auth-button auth-button-danger" data-auth-action="logout">Logout</button>
		`;
		authPanel.hidden = true;
		authPanel.innerHTML = "";
		uniqueCodeFooter.hidden = false;
		const installerOneLinerMasked = getMaskedInstallerOneLiner();
		uniqueCodeFooter.innerHTML = `
			<div class="auth-note auth-note-success unique-code-card">
				<p class="auth-note-title">User Unique Code</p>
				<p class="auth-note-text">Use this value for the <strong>User-Unique-Code</strong> header when calling <strong>/api/record-attendance</strong>.</p>
				<div class="auth-code-row">
					<input id="user-unique-code" class="auth-input auth-code-input" type="${uniqueCodeVisible ? "text" : "password"}" readonly tabindex="-1" title="Click to copy!" value="${escapeHtml(currentUser.uniqueCode)}" aria-label="User unique code" />
					<button type="button" class="auth-button auth-copy-button" data-auth-action="copy-unique-code">Copy</button>
					<button type="button" class="auth-button auth-eye-button" data-auth-action="toggle-unique-code-visibility" aria-label="${uniqueCodeVisible ? "Hide unique code" : "Show unique code"}">${uniqueCodeVisible ? "🙈" : "👁"}</button>
				</div>
			</div>
			<div class="auth-note install-script-card">
				<p class="auth-note-title">PowerShell One-Line Install</p>
				<p class="auth-note-text">Copy and run this in PowerShell to install auto attendance recording with your own code pre-filled.</p>
				<div class="auth-code-row">
					<input id="install-script-oneliner" class="auth-input auth-code-input install-script-input" type="text" readonly tabindex="-1" title="Click to copy!" value="${escapeHtml(installerOneLinerMasked)}" aria-label="PowerShell one-line install command" />
					<button type="button" class="auth-button auth-copy-button" data-auth-action="copy-install-oneliner">Copy</button>
				</div>
			</div>
			${adminSectionMarkup}
		`;
		forgotPasswordResult = null;
		forgotPasswordDraft = null;
		setStatsLocked(false);
		return;
	}

	if (currentUserLoading) {
		greetingElement.textContent = "Loading...";
		actionBar.innerHTML = "";
		authPanel.hidden = true;
		authPanel.innerHTML = "";
		uniqueCodeFooter.hidden = false;
		uniqueCodeFooter.innerHTML = `
			<div class="auth-note auth-note-success unique-code-card">
				<p class="auth-note-title">User Unique Code</p>
				<p class="auth-note-text">Use this value for the <strong>User-Unique-Code</strong> header when calling <strong>/api/record-attendance</strong>.</p>
				<div class="auth-code-row">
					<div class="skeleton skeleton-code-input"></div>
					<button type="button" class="auth-button auth-copy-button" disabled>Copy</button>
					<button type="button" class="auth-button auth-eye-button" disabled>👁</button>
				</div>
			</div>
			<div class="auth-note install-script-card">
				<p class="auth-note-title">PowerShell One-Line Install</p>
				<p class="auth-note-text">Copy and run this in PowerShell to install auto attendance recording with your own code pre-filled.</p>
				<div class="auth-code-row">
					<div class="skeleton skeleton-code-input"></div>
					<button type="button" class="auth-button auth-copy-button" disabled>Copy</button>
				</div>
			</div>
		`;
		setStatsLocked(true);
		return;
	}

	greetingElement.textContent = "You are not logged in";
	actionBar.innerHTML = "";
	authPanel.hidden = false;
	uniqueCodeVisible = false;
	adminUsers = [];
	selectedAdminUserId = null;
	adminUsersLoading = false;
	adminImpersonationInFlight = false;
	adminPanelMessage = "";
	uniqueCodeFooter.hidden = true;
	uniqueCodeFooter.innerHTML = "";

	const authHeading = authViewMode === "register" ? "Register" : "Login";
	const usernameInputId = `${authViewMode}-username`;
	const passwordInputId = `${authViewMode}-password`;
	const submitLabel = authHeading;

	authPanel.innerHTML = `
		<div class="auth-tab-row">
			<button type="button" class="auth-button auth-tab-button ${authViewMode === "login" ? "auth-tab-button-active" : ""}" data-auth-action="show-login">Login</button>
			<button type="button" class="auth-button auth-tab-button ${authViewMode === "register" ? "auth-tab-button-active" : ""}" data-auth-action="show-register">Register</button>
		</div>
		<form id="auth-form" class="auth-form auth-form-single" autocomplete="on">
			<h2 class="auth-form-title">${authHeading}</h2>
			<label class="auth-label" for="${usernameInputId}">Username</label>
			<input class="auth-input" id="${usernameInputId}" name="username" type="text" required />
			<label class="auth-label" for="${passwordInputId}">Password</label>
			<input class="auth-input" id="${passwordInputId}" name="password" type="password" required />
			<button class="auth-button auth-button-primary" type="submit">${submitLabel}</button>
			<button class="auth-button auth-button-secondary" type="button" data-auth-action="forgot-password">Forget password</button>
		</form>
		${
			forgotPasswordDraft
				? `<form id="forgot-password-form" class="auth-form auth-form-single auth-forgot-form" autocomplete="off">
					<h3 class="auth-form-title">Generate Manual Reset Hash</h3>
					<label class="auth-label" for="forgot-username">Username</label>
					<input class="auth-input" id="forgot-username" name="username" type="text" value="${escapeHtml(forgotPasswordDraft.username)}" required />
					<label class="auth-label" for="forgot-new-password">New password</label>
					<input class="auth-input" id="forgot-new-password" name="newPassword" type="password" required />
					<div class="auth-inline-actions">
						<button class="auth-button auth-button-primary" type="submit">Generate hash</button>
						<button class="auth-button" type="button" data-auth-action="cancel-forgot-password">Cancel</button>
					</div>
				</form>`
				: ""
		}
		${
			forgotPasswordResult
				? `<div class="auth-note auth-note-warning">
					<p class="auth-note-title">Manual Reset Hash Ready</p>
					<p class="auth-note-text"><strong>Username:</strong> ${escapeHtml(forgotPasswordResult.username)}</p>
					<div class="auth-code-row">
						<input id="forgot-password-hash" class="auth-input auth-code-input" type="text" readonly value="${escapeHtml(forgotPasswordResult.passwordHash)}" aria-label="Generated password hash" />
						<button type="button" class="auth-button auth-copy-button" data-auth-action="copy-forgot-hash">Copy</button>
					</div>
					<p class="auth-note-text auth-note-warning-text">Send this username and hash to <strong>Khanh Luong</strong> for manual password reset.</p>
				</div>`
				: ""
		}
		${authPanelMessage ? `<p class="auth-inline-message">${escapeHtml(authPanelMessage)}</p>` : ""}
	`;
	setStatsLocked(true);
}

async function fetchJsonOrThrow(url, options = {}) {
	const response = await fetch(url, options);
	let payload = null;

	try {
		payload = await response.json();
	} catch {
		payload = null;
	}

	if (!response.ok) {
		const errorMessage =
			payload?.error || payload?.details || `HTTP ${response.status}`;
		throw new Error(errorMessage);
	}

	return payload;
}

async function syncAuthState() {
	currentUserLoading = true;
	renderAuthUi();

	const authState = await fetchJsonOrThrow("/api/auth/me");
	if (authState?.authenticated && authState.user) {
		currentUser = authState.user;
	} else {
		currentUser = null;
	}

	currentUserLoading = false;
	renderAuthUi();
	await loadAdminUsersIfNeeded();
}

async function loadAdminUsersIfNeeded() {
	if (!currentUser?.isAdmin) {
		adminUsers = [];
		selectedAdminUserId = null;
		adminUsersLoading = false;
		adminImpersonationInFlight = false;
		adminPanelMessage = "";
		renderAuthUi();
		return;
	}

	adminUsersLoading = true;
	adminPanelMessage = "";
	renderAuthUi();

	try {
		const payload = await fetchJsonOrThrow("/api/admin/list-users");
		adminUsers = (payload?.users ?? []).map((user) => ({
			id: Number(user.id),
			username: `${user.username ?? ""}`,
			isAdmin: Boolean(user.isAdmin),
		}));

		if (adminUsers.length === 0) {
			selectedAdminUserId = null;
		} else if (
			!adminUsers.some(
				(user) => String(user.id) === String(selectedAdminUserId),
			)
		) {
			selectedAdminUserId = String(adminUsers[0].id);
		}
	} catch (error) {
		adminUsers = [];
		selectedAdminUserId = null;
		adminPanelMessage = `Failed to load users: ${error.message}`;
	} finally {
		adminUsersLoading = false;
		renderAuthUi();
	}
}

async function loadStats() {
	const statsGrid = document.getElementById("stats-grid");
	if (!statsGrid) {
		return;
	}

	if (!currentUser) {
		statsGrid.innerHTML = `
			<article class="stat-card stat-card-primary">
				<p class="stat-label">Stats Locked</p>
				<p class="stat-value">Login Required</p>
				<p class="stat-description">Authenticate to view your personalized attendance metrics.</p>
			</article>
		`;
		return;
	}

	try {
		const response = await fetch("/api/stats");
		if (!response.ok) {
			if (response.status === 401) {
				currentUser = null;
				authPanelMessage = "Session expired. Please login again.";
				resetDashboardData();
				renderAuthUi();
				loadStats();
				return;
			}

			throw new Error(`HTTP ${response.status}`);
		}

		const stats = await response.json();
		latestStatsPayload = stats;
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

function getMonthQueryToken(monthDateString) {
	const monthDate = parseIsoDate(monthDateString);
	const month = `${monthDate.getUTCMonth() + 1}`.padStart(2, "0");
	const year = `${monthDate.getUTCFullYear()}`.slice(-2);
	return `${month}/${year}`;
}

function getCalendarAttendedDateStringsForViewedMonth() {
	const attendedDates = new Set(workingAttendedDateSet);

	for (const [
		dateString,
		operation,
	] of pendingPersistenceOperations.entries()) {
		if (getMonthStartDateString(dateString) !== viewedMonthDateString) {
			continue;
		}

		if (operation.shouldMarkAttended) {
			attendedDates.add(dateString);
		} else {
			attendedDates.delete(dateString);
		}
	}

	return [...attendedDates];
}

async function fetchAndCacheMonth(monthDateString) {
	if (!currentUser || monthAttendanceCache.has(monthDateString)) {
		return;
	}

	try {
		const month = getMonthQueryToken(monthDateString);
		const payload = await fetchJsonOrThrow(
			`/api/attendance?month=${encodeURIComponent(month)}`,
		);
		if (!monthAttendanceCache.has(monthDateString)) {
			monthAttendanceCache.set(
				monthDateString,
				new Set(payload?.attendedDateStrings ?? []),
			);
			const prevMs = shiftMonthDateString(viewedMonthDateString, -1);
			const nextMs = shiftMonthDateString(viewedMonthDateString, 1);
			if (monthDateString === prevMs || monthDateString === nextMs) {
				renderCurrentStatsPreview();
			}
		}
	} catch (error) {
		console.error(
			"Failed to prefetch month attendance",
			monthDateString,
			error,
		);
	}
}

async function loadViewedMonthAttendance() {
	if (!currentUser || !viewedMonthDateString) {
		return;
	}

	const cachedAttendance = monthAttendanceCache.get(viewedMonthDateString);
	if (cachedAttendance) {
		syncViewedMonthAttendance(cachedAttendance);
		renderCurrentStatsPreview();
		void Promise.all([
			fetchAndCacheMonth(shiftMonthDateString(viewedMonthDateString, -1)),
			fetchAndCacheMonth(shiftMonthDateString(viewedMonthDateString, 1)),
		]);
		return;
	}

	const requestId = ++monthAttendanceLoadRequestId;
	monthAttendanceInFlight = true;
	renderCurrentStatsPreview();
	const currentMonthDateString = viewedMonthDateString;
	const prevMonthDateString = shiftMonthDateString(currentMonthDateString, -1);
	const nextMonthDateString = shiftMonthDateString(currentMonthDateString, 1);

	try {
		const currentMonthLoad = (async () => {
			const month = getMonthQueryToken(currentMonthDateString);
			const payload = await fetchJsonOrThrow(
				`/api/attendance?month=${encodeURIComponent(month)}`,
			);
			if (requestId !== monthAttendanceLoadRequestId) {
				return;
			}

			const attendedDateStrings = payload?.attendedDateStrings ?? [];
			monthAttendanceCache.set(
				currentMonthDateString,
				new Set(attendedDateStrings),
			);
			syncViewedMonthAttendance(attendedDateStrings);
			renderCurrentStatsPreview();
		})();

		await Promise.all([
			currentMonthLoad,
			fetchAndCacheMonth(prevMonthDateString),
			fetchAndCacheMonth(nextMonthDateString),
		]);
	} catch (error) {
		if (requestId !== monthAttendanceLoadRequestId) {
			return;
		}

		console.error("Failed to load attendance for viewed month", error);
	} finally {
		if (requestId === monthAttendanceLoadRequestId) {
			monthAttendanceInFlight = false;
			renderCurrentStatsPreview();
		}
	}
}

async function ensureViewedMonthAttendanceLoaded() {
	await loadViewedMonthAttendance();
}

async function loadDashboardData() {
	if (!currentUser) {
		await loadStats();
		return;
	}

	if (!viewedMonthDateString) {
		viewedMonthDateString = getInitialViewedMonthDateString();
	}

	await Promise.all([loadStats(), loadViewedMonthAttendance()]);
}

function buildMonthCalendarCells(
	monthDateString,
	todayDateString,
	attendedDateStrings,
	adjacentAttendedSets,
) {
	const monthDate = parseIsoDate(monthDateString);
	const year = monthDate.getUTCFullYear();
	const month = monthDate.getUTCMonth();
	const firstOfMonth = new Date(Date.UTC(year, month, 1));
	const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

	const mondayStartIndex = (firstOfMonth.getUTCDay() + 6) % 7;
	const cells = [];
	const attendedSet = new Set(attendedDateStrings || []);
	const prevMonthSet = adjacentAttendedSets?.prev ?? null;
	const nextMonthSet = adjacentAttendedSets?.next ?? null;

	for (let pad = 0; pad < mondayStartIndex; pad += 1) {
		const leadDate = new Date(
			Date.UTC(year, month, pad - mondayStartIndex + 1),
		);
		const leadIso = formatIsoDate(leadDate);
		const leadDay = leadDate.getUTCDate();
		const isAttendedFromAdjacent = prevMonthSet
			? prevMonthSet.has(leadIso)
			: false;
		const isAttended = isAttendedFromAdjacent || attendedSet.has(leadIso);
		const pendingPersistenceOperation = getPendingPersistenceOperation(leadIso);
		const isPendingPersistCreate =
			pendingPersistenceOperation?.shouldMarkAttended === true;
		const isUserUpdatedAttended =
			isAttended && !baselineAttendedDateSet.has(leadIso);
		const isToday = leadIso === todayDateString;

		let className = "calendar-cell calendar-cell-outside-month";
		if (isAttended) {
			className += isAttendedFromAdjacent
				? " calendar-cell-attended-adjacent"
				: " calendar-cell-attended";
		}
		if (isUserUpdatedAttended) {
			className += " calendar-cell-attended-user";
		}
		if (isToday) {
			className += " calendar-cell-today";
		}
		if (isPendingPersistCreate) {
			className += " calendar-cell-attended-pending";
		}

		cells.push(
			`<div class="${className} calendar-cell-clickable" data-date="${leadIso}" role="button" tabindex="0" aria-pressed="${isAttended}" title="${isAttended ? "Marked attended (temporary). Click to unmark." : "Not marked attended. Click to mark temporarily."}"><span class="calendar-day-number">${leadDay}</span></div>`,
		);
	}

	for (let day = 1; day <= daysInMonth; day += 1) {
		const date = new Date(Date.UTC(year, month, day));
		const iso = date.toISOString().slice(0, 10);

		const isAttended = attendedSet.has(iso);
		const pendingPersistenceOperation = getPendingPersistenceOperation(iso);
		const isPendingPersistCreate =
			pendingPersistenceOperation?.shouldMarkAttended === true;
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
		if (isPendingPersistCreate) {
			className += " calendar-cell-attended-pending";
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
		const isAttendedFromAdjacent = nextMonthSet
			? nextMonthSet.has(trailingIso)
			: false;
		const isAttended = isAttendedFromAdjacent || attendedSet.has(trailingIso);
		const pendingPersistenceOperation =
			getPendingPersistenceOperation(trailingIso);
		const isPendingPersistCreate =
			pendingPersistenceOperation?.shouldMarkAttended === true;
		const isUserUpdatedAttended =
			isAttended && !baselineAttendedDateSet.has(trailingIso);
		const isToday = trailingIso === todayDateString;

		let className = "calendar-cell calendar-cell-outside-month";
		if (isAttended) {
			className += isAttendedFromAdjacent
				? " calendar-cell-attended-adjacent"
				: " calendar-cell-attended";
		}
		if (isUserUpdatedAttended) {
			className += " calendar-cell-attended-user";
		}
		if (isToday) {
			className += " calendar-cell-today";
		}
		if (isPendingPersistCreate) {
			className += " calendar-cell-attended-pending";
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
	const currentDate = getUtcPlus7DateString();
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

	const prevMonthDateString = shiftMonthDateString(viewedMonthDateString, -1);
	const nextMonthDateString = shiftMonthDateString(viewedMonthDateString, 1);
	const adjacentAttendedSets = {
		prev: monthAttendanceCache.get(prevMonthDateString) ?? null,
		next: monthAttendanceCache.get(nextMonthDateString) ?? null,
	};
	const calendarCellsMarkup = buildMonthCalendarCells(
		viewedMonthDateString,
		currentDate,
		attendedDateStrings,
		adjacentAttendedSets,
	);
	const monthLabel = formatMonthLabel(viewedMonthDateString);
	const weekdayHeadersMarkup = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
		.map(
			(weekday) =>
				`<div class="calendar-weekday" aria-hidden="true">${weekday}</div>`,
		)
		.join("");

	const dashboardLoadingClass =
		attendanceUpdateInFlight ||
		getPersistenceInFlight() ||
		monthAttendanceInFlight
			? " dashboard-layout-preview-loading"
			: "";
	const usageHintText =
		attendanceUpdateInFlight ||
		getPersistenceInFlight() ||
		monthAttendanceInFlight
			? "Updating preview..."
			: "Tip: Click any date to preview. Ctrl+Click (or Cmd+Click) to save to database.";
	const showHistoricalLoadingBadge = monthAttendanceInFlight;

	const historicalLoadingBadgeMarkup = showHistoricalLoadingBadge
		? `<p class="calendar-historical-loading" role="status" aria-live="polite"><span class="calendar-historical-loading-spinner" aria-hidden="true"></span>Loading historical month attendance...</p>`
		: "";

	target.innerHTML = `
		<section class="dashboard-layout${dashboardLoadingClass}">
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
				${historicalLoadingBadgeMarkup}
				<p class="calendar-usage-hint">${usageHintText}</p>
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
	if (!currentUser) {
		throw new Error("Authentication required");
	}

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

function scheduleAttendancePreviewRefresh() {
	if (attendancePreviewDebounceTimer) {
		window.clearTimeout(attendancePreviewDebounceTimer);
	}

	const scheduledVersion = attendancePreviewVersion;
	attendancePreviewDebounceTimer = window.setTimeout(() => {
		attendancePreviewDebounceTimer = null;
		void flushAttendancePreviewRefresh(scheduledVersion);
	}, ATTENDANCE_PREVIEW_DEBOUNCE_MS);
}

async function flushAttendancePreviewRefresh(scheduledVersion) {
	if (!currentUser || scheduledVersion !== attendancePreviewVersion) {
		return;
	}

	const requestId = ++attendancePreviewRequestId;
	attendanceUpdateInFlight = true;
	renderCurrentStatsPreview();

	try {
		const previewStats = await recalculatePreviewStats([
			...workingAttendedDateSet,
		]);
		if (
			requestId !== attendancePreviewRequestId ||
			scheduledVersion !== attendancePreviewVersion
		) {
			return;
		}

		latestStatsPayload = previewStats;
		renderCurrentStatsPreview();
	} catch (error) {
		if (
			requestId !== attendancePreviewRequestId ||
			scheduledVersion !== attendancePreviewVersion
		) {
			return;
		}

		console.error("Failed to refresh attendance preview", error);
	} finally {
		if (requestId === attendancePreviewRequestId) {
			attendanceUpdateInFlight = false;
			renderCurrentStatsPreview();
		}
	}
}

async function handleAttendanceToggleCell(calendarCell) {
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

	attendancePreviewVersion += 1;
	renderCurrentStatsPreview();
	scheduleAttendancePreviewRefresh();
}

async function persistAttendanceToggle(dateString) {
	if (!currentUser) {
		throw new Error("Authentication required");
	}

	const response = await fetch("/api/attendance/toggle", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ date: dateString }),
	});

	if (!response.ok) {
		let payload = null;
		try {
			payload = await response.json();
		} catch {
			payload = null;
		}

		throw new Error(
			payload?.error || payload?.details || `HTTP ${response.status}`,
		);
	}

	return response.json();
}

async function handleAttendancePersistentToggle(calendarCell) {
	const dateString = calendarCell.dataset.date;
	if (!dateString) {
		return;
	}

	if (pendingPersistenceOperations.has(dateString)) {
		return;
	}

	const currentAttendedDates = new Set(
		getCalendarAttendedDateStringsForViewedMonth(),
	);
	const shouldMarkAttended = !currentAttendedDates.has(dateString);
	const operation = {
		shouldMarkAttended,
		requestId: crypto.randomUUID(),
	};
	pendingPersistenceOperations.set(dateString, operation);

	renderCurrentStatsPreview();

	try {
		await persistAttendanceToggle(dateString);

		const settledOperation = pendingPersistenceOperations.get(dateString);
		if (
			!settledOperation ||
			settledOperation.requestId !== operation.requestId
		) {
			return;
		}

		if (operation.shouldMarkAttended) {
			baselineAttendedDateSet.add(dateString);
			workingAttendedDateSet.add(dateString);
		} else {
			baselineAttendedDateSet.delete(dateString);
			workingAttendedDateSet.delete(dateString);
		}

		const monthStart = getMonthStartDateString(dateString);
		if (monthAttendanceCache.has(monthStart)) {
			const monthSet = new Set(monthAttendanceCache.get(monthStart));
			if (operation.shouldMarkAttended) {
				monthSet.add(dateString);
			} else {
				monthSet.delete(dateString);
			}
			monthAttendanceCache.set(monthStart, monthSet);
		}
	} catch (error) {
		console.error("Failed to toggle attendance persistently", error);
	} finally {
		const settledOperation = pendingPersistenceOperations.get(dateString);
		if (settledOperation?.requestId === operation.requestId) {
			pendingPersistenceOperations.delete(dateString);
		}
		renderCurrentStatsPreview();
	}
}

function registerCalendarInteractions() {
	const statsGrid = document.getElementById("stats-grid");
	if (!statsGrid) {
		return;
	}

	async function changeViewedMonth(monthOffset) {
		if (!latestStatsPayload || !viewedMonthDateString) {
			return;
		}

		viewedMonthDateString = shiftMonthDateString(
			viewedMonthDateString,
			monthOffset,
		);
		await ensureViewedMonthAttendanceLoaded();
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
				void changeViewedMonth(monthOffset);
			}
			return;
		}

		const calendarCell = event.target.closest(".calendar-cell-clickable");
		if (!calendarCell) {
			return;
		}

		if (event.ctrlKey || event.metaKey) {
			void handleAttendancePersistentToggle(calendarCell);
			return;
		}

		void handleAttendanceToggleCell(calendarCell);
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

		if (event.ctrlKey || event.metaKey) {
			void handleAttendancePersistentToggle(calendarCell);
			return;
		}

		void handleAttendanceToggleCell(calendarCell);
	});
}

function registerAuthInteractions() {
	const authPanel = document.getElementById("auth-panel");
	const actionBar = document.getElementById("auth-action-bar");
	const uniqueCodeFooter = document.getElementById("unique-code-footer");

	if (!authPanel || !actionBar || !uniqueCodeFooter) {
		return;
	}

	actionBar.addEventListener("click", async (event) => {
		if (!(event.target instanceof Element)) {
			return;
		}

		const button = event.target.closest("button[data-auth-action]");
		if (!button) {
			return;
		}

		const action = button.getAttribute("data-auth-action");
		if (action !== "logout") {
			return;
		}

		try {
			await fetchJsonOrThrow("/api/auth/logout", { method: "POST" });
			currentUser = null;
			uniqueCodeVisible = false;
			adminUsers = [];
			selectedAdminUserId = null;
			adminUsersLoading = false;
			adminImpersonationInFlight = false;
			adminPanelMessage = "";
			authPanelMessage = "Logged out successfully.";
			resetDashboardData();
			renderAuthUi();
			await loadDashboardData();
		} catch (error) {
			authPanelMessage = `Logout failed: ${error.message}`;
			renderAuthUi();
		}
	});

	authPanel.addEventListener("click", async (event) => {
		if (!(event.target instanceof Element)) {
			return;
		}

		const button = event.target.closest("button[data-auth-action]");
		if (!button) {
			return;
		}

		const action = button.getAttribute("data-auth-action");
		if (action === "show-register" || action === "show-login") {
			authViewMode = action === "show-register" ? "register" : "login";
			authPanelMessage = "";
			forgotPasswordResult = null;
			renderAuthUi();
			document.getElementById(`${authViewMode}-username`)?.focus();
			return;
		}

		if (action === "forgot-password") {
			const fallbackUsernameInput = document.getElementById(
				`${authViewMode}-username`,
			);
			const initialUsername =
				fallbackUsernameInput instanceof HTMLInputElement
					? fallbackUsernameInput.value.trim()
					: "";
			forgotPasswordDraft = { username: initialUsername };
			authPanelMessage = "";
			renderAuthUi();
			return;
		}
		if (action === "cancel-forgot-password") {
			forgotPasswordDraft = null;
			renderAuthUi();
			return;
		}

		if (action === "copy-forgot-hash") {
			if (!forgotPasswordResult) {
				return;
			}

			try {
				const textToCopy = `Username: ${forgotPasswordResult.username}\nPassword hash: ${forgotPasswordResult.passwordHash}`;
				await navigator.clipboard.writeText(textToCopy);
				authPanelMessage = "Reset hash copied to clipboard.";
			} catch {
				authPanelMessage =
					"Unable to copy automatically. Please copy manually.";
			}

			renderAuthUi();
		}
	});

	uniqueCodeFooter.addEventListener("click", async (event) => {
		if (!(event.target instanceof Element)) {
			return;
		}

		const codeInput = event.target.closest("input.auth-code-input");
		if (codeInput instanceof HTMLInputElement) {
			if (codeInput.id === "user-unique-code") {
				if (!currentUser?.uniqueCode) {
					return;
				}

				try {
					await navigator.clipboard.writeText(currentUser.uniqueCode);
					authPanelMessage = "Unique code copied to clipboard.";
				} catch {
					authPanelMessage =
						"Unable to copy automatically. Please copy manually.";
				}

				renderAuthUi();
			}

			if (codeInput.id === "install-script-oneliner") {
				if (!currentUser?.uniqueCode) {
					return;
				}

				try {
					await navigator.clipboard.writeText(
						getInstallerOneLiner(currentUser.uniqueCode),
					);
					authPanelMessage = "Install command copied to clipboard.";
				} catch {
					authPanelMessage =
						"Unable to copy automatically. Please copy manually.";
				}

				renderAuthUi();
			}

			return;
		}

		const button = event.target.closest("button[data-auth-action]");
		if (!button) {
			return;
		}

		const action = button.getAttribute("data-auth-action");
		if (action === "copy-unique-code") {
			if (!currentUser?.uniqueCode) {
				return;
			}

			try {
				await navigator.clipboard.writeText(currentUser.uniqueCode);
				authPanelMessage = "Unique code copied to clipboard.";
			} catch {
				authPanelMessage =
					"Unable to copy automatically. Please copy manually.";
			}

			renderAuthUi();
			return;
		}

		if (action === "copy-install-oneliner") {
			if (!currentUser?.uniqueCode) {
				return;
			}

			try {
				await navigator.clipboard.writeText(
					getInstallerOneLiner(currentUser.uniqueCode),
				);
				authPanelMessage = "Install command copied to clipboard.";
			} catch {
				authPanelMessage =
					"Unable to copy automatically. Please copy manually.";
			}

			renderAuthUi();
			return;
		}

		if (action === "toggle-unique-code-visibility") {
			uniqueCodeVisible = !uniqueCodeVisible;
			renderAuthUi();
			return;
		}

		if (action === "admin-impersonate") {
			if (!currentUser?.isAdmin || !selectedAdminUserId) {
				return;
			}

			adminImpersonationInFlight = true;
			adminPanelMessage = "";
			renderAuthUi();

			try {
				const result = await fetchJsonOrThrow("/api/admin/impersonate", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						userId: Number(selectedAdminUserId),
					}),
				});

				currentUser = result?.user ?? null;
				authPanelMessage = result?.message ?? "Switched user successfully.";
				baselineAttendedDateSet = new Set();
				workingAttendedDateSet = new Set();
				latestStatsPayload = null;
				viewedMonthDateString = null;
				adminUsers = [];
				selectedAdminUserId = null;
				adminPanelMessage = "";
				renderAuthUi();
				await loadStats();
			} catch (error) {
				adminPanelMessage = `Failed to login as selected user: ${error.message}`;
				renderAuthUi();
			} finally {
				adminImpersonationInFlight = false;
				renderAuthUi();
			}
		}
	});

	uniqueCodeFooter.addEventListener("mouseover", (event) => {
		if (!(event.target instanceof Element)) {
			return;
		}

		const codeInput = event.target.closest("input.auth-code-input");
		if (!(codeInput instanceof HTMLInputElement)) {
			return;
		}

		codeInput.type = "text";
		codeInput.value = "Click to copy!";
	});

	uniqueCodeFooter.addEventListener("mouseout", (event) => {
		if (!(event.target instanceof Element)) {
			return;
		}

		const codeInput = event.target.closest("input.auth-code-input");
		if (!(codeInput instanceof HTMLInputElement)) {
			return;
		}

		if (codeInput.id === "user-unique-code") {
			if (!currentUser?.uniqueCode) {
				return;
			}

			codeInput.type = uniqueCodeVisible ? "text" : "password";
			codeInput.value = currentUser.uniqueCode;
			return;
		}

		if (codeInput.id === "install-script-oneliner") {
			codeInput.type = "text";
			codeInput.value = getMaskedInstallerOneLiner();
		}
	});

	uniqueCodeFooter.addEventListener("mousedown", (event) => {
		if (!(event.target instanceof Element)) {
			return;
		}

		if (event.target.closest("input.auth-code-input")) {
			event.preventDefault();
		}
	});

	uniqueCodeFooter.addEventListener("selectstart", (event) => {
		if (!(event.target instanceof Element)) {
			return;
		}

		if (event.target.closest("input.auth-code-input")) {
			event.preventDefault();
		}
	});

	uniqueCodeFooter.addEventListener("change", (event) => {
		if (!(event.target instanceof HTMLSelectElement)) {
			return;
		}

		if (event.target.id !== "admin-user-select") {
			return;
		}

		selectedAdminUserId = event.target.value;
		renderAuthUi();
	});

	authPanel.addEventListener("submit", async (event) => {
		event.preventDefault();

		if (!(event.target instanceof HTMLFormElement)) {
			return;
		}

		if (event.target.id === "forgot-password-form") {
			const forgotFormData = new FormData(event.target);
			const username = `${forgotFormData.get("username") ?? ""}`.trim();
			const newPassword = `${forgotFormData.get("newPassword") ?? ""}`;

			if (!username || !newPassword) {
				authPanelMessage = "Username and new password are required.";
				renderAuthUi();
				return;
			}

			try {
				const result = await fetchJsonOrThrow(
					"/api/auth/forgot-password-hash",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
						},
						body: JSON.stringify({ username, newPassword }),
					},
				);

				forgotPasswordResult = result;
				forgotPasswordDraft = null;
				authPanelMessage = "Hash generated. Share it with Khanh Luong.";
			} catch (error) {
				forgotPasswordResult = null;
				authPanelMessage = `Failed to generate hash: ${error.message}`;
			}

			renderAuthUi();
			return;
		}

		const formData = new FormData(event.target);
		const username = `${formData.get("username") ?? ""}`.trim();
		const password = `${formData.get("password") ?? ""}`;

		if (!username || !password) {
			authPanelMessage = "Username and password are required.";
			renderAuthUi();
			return;
		}

		const endpoint =
			authViewMode === "register" ? "/api/auth/register" : "/api/auth/login";

		try {
			const authResponse = await fetchJsonOrThrow(endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ username, password }),
			});

			currentUser = authResponse.user;
			authPanelMessage = "";
			resetDashboardData();
			renderAuthUi();
			await loadAdminUsersIfNeeded();
			await loadDashboardData();
		} catch (error) {
			authPanelMessage = `Authentication failed: ${error.message}`;
			renderAuthUi();
		}
	});
}

async function initializeApp() {
	registerCalendarInteractions();
	registerAuthInteractions();

	try {
		await syncAuthState();
	} catch {
		currentUser = null;
		authPanelMessage = "Unable to check auth state. Try refreshing.";
		renderAuthUi();
	}

	await loadDashboardData();
}

initializeApp();
