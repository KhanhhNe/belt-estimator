import { env } from "cloudflare:workers";
import bcrypt from "bcryptjs";
import { and, asc, eq, gte, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import schema from "./db/schema.js";
import beltStats from "./services/beltStats.js";

const { attendanceRecords, sessions, users } = schema;
const { calculateBeltStats, fetchAttendedDateStrings } = beltStats;
const UNIQUE_CODE_LENGTH = 8;
const UNIQUE_CODE_CHARSET =
	"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const BCRYPT_SALT_ROUNDS = 10;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);

let cachedDb = null;
const SESSION_COOKIE_NAME = "belt_sid";

const app = new Hono();

function _redactRequestBody(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return value;
	}

	const redacted = {};
	for (const [key, nestedValue] of Object.entries(value)) {
		if (
			key.toLowerCase().includes("password") ||
			key.toLowerCase().includes("hash")
		) {
			redacted[key] = "[FILTERED]";
			continue;
		}

		redacted[key] = nestedValue;
	}

	return redacted;
}

function getUtcPlus7DateString(now = new Date()) {
	const localTimeInUtcPlus7 = new Date(now.getTime() + 7 * 60 * 60 * 1000);
	return localTimeInUtcPlus7.toISOString().slice(0, 10);
}

function maskUniqueCode(value = "") {
	if (!value) {
		return "[missing]";
	}

	if (value.length <= 4) {
		return "****";
	}

	return `${value.slice(0, 2)}****${value.slice(-2)}`;
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

function errorJson(_context, status, errorMessage, details, _metadata = {}) {
	return json(
		{
			error: errorMessage,
			details,
		},
		status,
	);
}

function parseCookies(cookieHeader = "") {
	return cookieHeader
		.split(";")
		.map((part) => part.trim())
		.filter(Boolean)
		.reduce((acc, cookiePart) => {
			const separatorIndex = cookiePart.indexOf("=");
			if (separatorIndex === -1) {
				return acc;
			}

			const key = cookiePart.slice(0, separatorIndex).trim();
			const value = cookiePart.slice(separatorIndex + 1).trim();
			acc[key] = decodeURIComponent(value);
			return acc;
		}, {});
}

async function createSessionForUser(user, db) {
	const sessionId = crypto.randomUUID();
	await db.insert(sessions).values({
		sessionId,
		userId: user.id,
		createdAt: Date.now(),
	});
	return sessionId;
}

async function getSessionFromRequest(request, env) {
	const cookies = parseCookies(request.headers.get("Cookie") ?? "");
	const sessionId = cookies[SESSION_COOKIE_NAME];
	if (!sessionId) {
		return null;
	}

	const db = getDbForEnv(env);
	const matchedSessions = await db
		.select({
			id: sessions.sessionId,
			userId: sessions.userId,
			username: users.username,
			createdAt: sessions.createdAt,
		})
		.from(sessions)
		.innerJoin(users, eq(users.id, sessions.userId))
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);

	const session = matchedSessions[0];
	if (!session) {
		return null;
	}

	const now = Date.now();
	if (now - session.createdAt > SESSION_TTL_MS) {
		await db.delete(sessions).where(eq(sessions.sessionId, session.id));
		return null;
	}

	await db
		.update(sessions)
		.set({ createdAt: now })
		.where(eq(sessions.sessionId, session.id));

	return session;
}

async function deleteSessionById(sessionId, env) {
	const db = getDbForEnv(env);
	await db.delete(sessions).where(eq(sessions.sessionId, sessionId));
}

function withSessionCookie(data, sessionId, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json",
			"Set-Cookie": `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; SameSite=Lax`,
		},
	});
}

function withClearedSessionCookie(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json",
			"Set-Cookie": `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
		},
	});
}

function buildAuthResponse(session, user = null) {
	if (!session) {
		return {
			authenticated: false,
			user: null,
		};
	}

	return {
		authenticated: true,
		user: {
			id: session.userId,
			username: user?.username ?? session.username,
			uniqueCode: user?.uniqueCode,
			isAdmin: Boolean(user?.isAdmin),
		},
	};
}

async function getAuthenticatedUserFromRequest(request, env) {
	const session = await getSessionFromRequest(request, env);
	if (!session) {
		return {
			errorResponse: errorJson(
				"auth",
				401,
				"Authentication required",
				"Log in to access this endpoint",
			),
		};
	}

	const db = getDbForEnv(env);
	const matchedUsers = await db
		.select({
			id: users.id,
			username: users.username,
			uniqueCode: users.uniqueCode,
			isAdmin: users.isAdmin,
		})
		.from(users)
		.where(eq(users.id, session.userId))
		.limit(1);

	const matchedUser = matchedUsers[0];
	if (!matchedUser) {
		console.error(
			"[auth] Session user not found; clearing session",
			JSON.stringify({ sessionId: session.id, userId: session.userId }),
		);
		await deleteSessionById(session.id, env);
		return {
			errorResponse: withClearedSessionCookie(buildAuthResponse(null)),
		};
	}

	return {
		db,
		session,
		user: matchedUser,
	};
}

function getPasswordHashSecret(env) {
	const secret = env.PASSWORD_HASH_SECRET;
	if (!secret || typeof secret !== "string") {
		throw new Error("Missing PASSWORD_HASH_SECRET in environment");
	}

	return secret;
}

async function hashPassword(password, env) {
	const secret = getPasswordHashSecret(env);
	return bcrypt.hash(`${password}${secret}`, BCRYPT_SALT_ROUNDS);
}

async function verifyPassword(password, passwordHash, env) {
	const secret = getPasswordHashSecret(env);
	return bcrypt.compare(`${password}${secret}`, passwordHash);
}

function randomAlphanumericCode(length = UNIQUE_CODE_LENGTH) {
	let value = "";

	while (value.length < length) {
		const bytes = new Uint8Array(length);
		crypto.getRandomValues(bytes);

		for (const byte of bytes) {
			if (byte >= 248) {
				continue;
			}

			const index = byte % UNIQUE_CODE_CHARSET.length;
			value += UNIQUE_CODE_CHARSET[index];
			if (value.length >= length) {
				break;
			}
		}
	}

	return value;
}

async function generateUniqueCode(db) {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const candidate = randomAlphanumericCode();
		const existing = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.uniqueCode, candidate))
			.limit(1);

		if (existing.length === 0) {
			return candidate;
		}
	}

	throw new Error("Unable to generate unique code");
}

function getDbForEnv(env) {
	if (!env?.belt_estimator) {
		throw new Error("Missing D1 binding belt_estimator in Worker environment");
	}

	if (!cachedDb) {
		cachedDb = drizzle(env.belt_estimator);
	}

	return cachedDb;
}

function parseAttendanceMonth(monthToken) {
	const value = `${monthToken ?? ""}`.trim();
	const shortMatch = value.match(/^(\d{2})\/(\d{2})$/);
	if (shortMatch) {
		const month = Number(shortMatch[1]);
		const year = 2000 + Number(shortMatch[2]);
		if (month >= 1 && month <= 12) {
			return { year, month };
		}
	}

	const longMatch = value.match(/^(\d{2})\/(\d{4})$/);
	if (longMatch) {
		const month = Number(longMatch[1]);
		const year = Number(longMatch[2]);
		if (month >= 1 && month <= 12) {
			return { year, month };
		}
	}

	return null;
}

function formatMonthRangeBoundary(year, month) {
	return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-01`;
}
app.get("/", (c) => {
	return c.json({ message: "Hono.js running on Cloudflare Workers!" });
});

// app.use("/api/*", async (c, next) => {
// 	const startedAt = Date.now();
// 	const startedIso = new Date(startedAt).toISOString();
// 	const remoteIp =
// 		c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
// 	const format = c.req.header("content-type")?.includes("application/json")
// 		? "JSON"
// 		: "HTML";
// 	const parsedBody = ["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)
// 		? await c.req.json().catch(() => ({}))
// 		: {};
// 	const safeParams = redactRequestBody(parsedBody);
//
// 	console.log(
// 		`Started ${c.req.method} "${new URL(c.req.url).pathname}" for ${remoteIp} at ${startedIso}`,
// 	);
// 	console.log(`Processing by Worker as ${format}`);
// 	if (Object.keys(safeParams).length > 0) {
// 		console.log(`Parameters: ${JSON.stringify(safeParams)}`);
// 	}
//
// 	await next();
//
// 	const durationMs = Date.now() - startedAt;
// 	console.log(
// 		`Completed ${c.res.status} in ${durationMs}ms (Bytes: ${c.res.headers.get("content-length") ?? "unknown"})`,
// 	);
// });

app.post("/api/auth/register", async (c) => {
	const body = await c.req.json();
	const username = `${body?.username ?? ""}`.trim();
	const password = `${body?.password ?? ""}`;

	if (!username || !password) {
		return errorJson(
			"auth-register",
			400,
			"Invalid payload",
			"username and password are required",
		);
	}

	const db = getDbForEnv(env);
	const existingUsers = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.username, username))
		.limit(1);

	if (existingUsers.length > 0) {
		return errorJson(
			"auth-register",
			409,
			"Username already exists",
			"Choose another username",
			{ username },
		);
	}

	const uniqueCode = await generateUniqueCode(db);
	const passwordHash = await hashPassword(password, env);
	const insertedUsers = await db
		.insert(users)
		.values({ username, password: passwordHash, uniqueCode })
		.returning({
			id: users.id,
			username: users.username,
			uniqueCode: users.uniqueCode,
			isAdmin: users.isAdmin,
		});

	const insertedUser = insertedUsers[0];
	const sessionId = await createSessionForUser(insertedUser, db);
	return withSessionCookie(
		{
			message: "Registered successfully",
			...buildAuthResponse(
				{ userId: insertedUser.id, username: insertedUser.username },
				insertedUser,
			),
		},
		sessionId,
		201,
	);
});
app.post("/api/auth/login", async (c) => {
	const body = await c.req.json();
	const username = `${body?.username ?? ""}`.trim();
	const password = `${body?.password ?? ""}`;

	if (!username || !password) {
		return errorJson(
			"auth-login",
			400,
			"Invalid payload",
			"username and password are required",
		);
	}

	const db = getDbForEnv(env);
	const matchedUsers = await db
		.select({
			id: users.id,
			username: users.username,
			password: users.password,
			uniqueCode: users.uniqueCode,
			isAdmin: users.isAdmin,
		})
		.from(users)
		.where(eq(users.username, username))
		.limit(1);

	const matchedUser = matchedUsers[0];
	if (!matchedUser) {
		return errorJson(
			"auth-login",
			401,
			"Invalid credentials",
			"Incorrect username or password",
			{ username },
		);
	}

	const isPasswordValid = await verifyPassword(
		password,
		matchedUser.password,
		env,
	);
	if (!isPasswordValid) {
		return errorJson(
			"auth-login",
			401,
			"Invalid credentials",
			"Incorrect username or password",
			{ username },
		);
	}

	const sessionId = await createSessionForUser(matchedUser, db);
	return withSessionCookie(
		{
			message: "Logged in successfully",
			...buildAuthResponse(
				{ userId: matchedUser.id, username: matchedUser.username },
				matchedUser,
			),
		},
		sessionId,
	);
});
app.post("/api/auth/logout", async (c) => {
	const request = c.req.raw;
	const session = await getSessionFromRequest(request, env);
	if (session) {
		await deleteSessionById(session.id, env);
	}

	return withClearedSessionCookie({
		authenticated: false,
		message: "Logged out",
	});
});
app.get("/api/auth/me", async (c) => {
	const request = c.req.raw;
	const authResult = await getAuthenticatedUserFromRequest(request, env);
	if (authResult.errorResponse) {
		if (authResult.errorResponse.status === 401) {
			return json(buildAuthResponse(null));
		}

		return authResult.errorResponse;
	}

	const { session, user } = authResult;
	return withSessionCookie(buildAuthResponse(session, user), session.id);
});
app.post("/api/auth/forgot-password-hash", async (c) => {
	const body = await c.req.json();
	const username = `${body?.username ?? ""}`.trim();
	const newPassword = `${body?.newPassword ?? ""}`;

	if (!username || !newPassword) {
		return errorJson(
			"forgot-password-hash",
			400,
			"Invalid payload",
			"username and newPassword are required",
		);
	}

	const db = getDbForEnv(env);
	const matchedUsers = await db
		.select({ id: users.id, username: users.username })
		.from(users)
		.where(eq(users.username, username))
		.limit(1);

	const matchedUser = matchedUsers[0];
	if (!matchedUser) {
		return errorJson(
			"forgot-password-hash",
			404,
			"User not found",
			"No user exists with the provided username",
			{ username },
		);
	}

	const passwordHash = await hashPassword(newPassword, env);
	return json({
		username: matchedUser.username,
		passwordHash,
		hint: "Send this username and password hash to Khanh Luong for manual password reset.",
	});
});

app.use("/api/admin/*", async (c, next) => {
	const request = c.req.raw;
	const authResult = await getAuthenticatedUserFromRequest(request, env);
	if (authResult.errorResponse) {
		return authResult.errorResponse;
	}

	if (!authResult.user.isAdmin) {
		return errorJson(
			"admin-authz",
			403,
			"Forbidden",
			"Admin privileges required",
			{ username: authResult.user.username },
		);
	}

	await next();
});

app.get("/api/admin/list-users", async (c) => {
	const request = c.req.raw;
	const authResult = await getAuthenticatedUserFromRequest(request, env);
	if (authResult.errorResponse) {
		return authResult.errorResponse;
	}

	const { db, user } = authResult;
	if (!user.isAdmin) {
		return errorJson(
			"admin-list-users",
			403,
			"Forbidden",
			"Admin privileges required",
			{ username: user.username },
		);
	}

	const rows = await db
		.select({
			id: users.id,
			username: users.username,
			isAdmin: users.isAdmin,
		})
		.from(users)
		.orderBy(asc(users.username));

	return json({
		users: rows.map((row) => ({
			id: row.id,
			username: row.username,
			isAdmin: Boolean(row.isAdmin),
		})),
	});
});
app.post("/api/admin/impersonate", async (c) => {
	const request = c.req.raw;
	const authResult = await getAuthenticatedUserFromRequest(request, env);
	if (authResult.errorResponse) {
		return authResult.errorResponse;
	}

	const { db, session, user } = authResult;
	if (!user.isAdmin) {
		return errorJson(
			"admin-impersonate",
			403,
			"Forbidden",
			"Admin privileges required",
			{ username: user.username },
		);
	}

	const body = await c.req.json();
	const userId = Number(body?.userId);
	if (!Number.isInteger(userId) || userId <= 0) {
		return errorJson(
			"admin-impersonate",
			400,
			"Invalid payload",
			"userId must be a positive integer",
		);
	}

	const matchedUsers = await db
		.select({
			id: users.id,
			username: users.username,
			uniqueCode: users.uniqueCode,
			isAdmin: users.isAdmin,
		})
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);

	const targetUser = matchedUsers[0];
	if (!targetUser) {
		return errorJson(
			"admin-impersonate",
			404,
			"User not found",
			"The selected user does not exist",
			{ requestedUserId: userId },
		);
	}

	const newSessionId = await createSessionForUser(targetUser, db);
	await deleteSessionById(session.id, env);

	return withSessionCookie(
		{
			message: `Now logged in as ${targetUser.username}`,
			...buildAuthResponse(
				{ userId: targetUser.id, username: targetUser.username },
				targetUser,
			),
		},
		newSessionId,
	);
});
app.post("/api/record-attendance", async (c) => {
	const request = c.req.raw;
	const requestStartedAt = Date.now();
	const requestUrl = new URL(request.url);
	const logPrefix = "[record-attendance]";
	const attendanceDate = getUtcPlus7DateString();
	const db = getDbForEnv(env);
	const userUniqueCode = request.headers.get("User-Unique-Code")?.trim();

	console.log(
		`${logPrefix} Request received`,
		JSON.stringify({
			method: request.method,
			path: requestUrl.pathname,
			date: attendanceDate,
			hasUniqueCode: Boolean(userUniqueCode),
			uniqueCodeHint: maskUniqueCode(userUniqueCode ?? ""),
		}),
	);

	if (!userUniqueCode) {
		console.error(
			`${logPrefix} Missing User-Unique-Code header after ${Date.now() - requestStartedAt}ms`,
		);
		return errorJson(
			"record-attendance",
			401,
			"Missing User-Unique-Code",
			"Provide header User-Unique-Code with a valid user unique code",
		);
	}

	const matchedUsers = await db
		.select({ id: users.id, username: users.username })
		.from(users)
		.where(eq(users.uniqueCode, userUniqueCode))
		.limit(1);

	const matchedUser = matchedUsers[0];
	if (!matchedUser) {
		console.error(
			`${logPrefix} Invalid unique code`,
			JSON.stringify({
				uniqueCodeHint: maskUniqueCode(userUniqueCode),
				durationMs: Date.now() - requestStartedAt,
			}),
		);
		return errorJson(
			"record-attendance",
			403,
			"Invalid User-Unique-Code",
			"The provided unique code does not match any user",
		);
	}

	const result = await db
		.insert(attendanceRecords)
		.values({ date: attendanceDate, userId: matchedUser.id })
		.onConflictDoNothing({
			target: [attendanceRecords.userId, attendanceRecords.date],
		})
		.returning({ insertedDate: attendanceRecords.date });

	const created = result.length > 0;
	console.log(
		`${logPrefix} Attendance write completed`,
		JSON.stringify({
			created,
			date: attendanceDate,
			userId: matchedUser.id,
			username: matchedUser.username,
			durationMs: Date.now() - requestStartedAt,
		}),
	);

	return json({
		created,
		date: attendanceDate,
		username: matchedUser.username,
		message: created
			? "Attendance recorded"
			: "Attendance already exists for this UTC+7 date",
	});
});
app.post("/api/attendance/toggle", async (c) => {
	const request = c.req.raw;
	const session = await getSessionFromRequest(request, env);
	if (!session) {
		return errorJson(
			"attendance-toggle",
			401,
			"Authentication required",
			"Log in to toggle attendance",
		);
	}

	const body = await c.req.json();
	const date = `${body?.date ?? ""}`.trim();

	if (!isValidIsoDate(date)) {
		return errorJson(
			"attendance-toggle",
			400,
			"Invalid payload",
			"date is required and must be YYYY-MM-DD",
		);
	}

	const db = getDbForEnv(env);
	const existingRows = await db
		.select({ id: attendanceRecords.id })
		.from(attendanceRecords)
		.where(
			and(
				eq(attendanceRecords.userId, session.userId),
				eq(attendanceRecords.date, date),
			),
		)
		.limit(1);

	const existing = existingRows[0];
	if (existing) {
		await db
			.delete(attendanceRecords)
			.where(eq(attendanceRecords.id, existing.id));

		return json({
			action: "deleted",
			date,
			message: "Attendance removed",
		});
	}

	await db.insert(attendanceRecords).values({
		userId: session.userId,
		date,
	});

	return json({
		action: "created",
		date,
		message: "Attendance recorded",
	});
});
app.get("/api/attendance", async (c) => {
	const request = c.req.raw;
	const session = await getSessionFromRequest(request, env);
	if (!session) {
		return errorJson(
			"attendance-month",
			401,
			"Authentication required",
			"Log in to access this endpoint",
		);
	}

	const url = new URL(request.url);
	const parsed = parseAttendanceMonth(url.searchParams.get("month"));
	if (!parsed) {
		return errorJson(
			"attendance-month",
			400,
			"Invalid month",
			"month query must be MM/YY or MM/YYYY",
		);
	}

	const startDate = formatMonthRangeBoundary(parsed.year, parsed.month);
	const nextMonth = parsed.month === 12 ? 1 : parsed.month + 1;
	const nextMonthYear = parsed.month === 12 ? parsed.year + 1 : parsed.year;
	const endDateExclusive = formatMonthRangeBoundary(nextMonthYear, nextMonth);

	const db = getDbForEnv(env);
	const rows = await db
		.select({ date: attendanceRecords.date })
		.from(attendanceRecords)
		.where(
			and(
				eq(attendanceRecords.userId, session.userId),
				gte(attendanceRecords.date, startDate),
				lt(attendanceRecords.date, endDateExclusive),
			),
		)
		.orderBy(asc(attendanceRecords.date));

	return json({
		month: `${parsed.month.toString().padStart(2, "0")}/${String(parsed.year).slice(-2)}`,
		startDate,
		endDateExclusive,
		attendedDateStrings: rows.map((row) => row.date),
	});
});
app.post("/api/stats/preview", async (c) => {
	const request = c.req.raw;
	const session = await getSessionFromRequest(request, env);
	if (!session) {
		return errorJson(
			"stats-preview",
			401,
			"Authentication required",
			"Log in to access this endpoint",
		);
	}

	const body = await c.req.json();
	const requestedDates = body?.attendedDateStrings;

	if (!Array.isArray(requestedDates)) {
		return errorJson(
			"stats-preview",
			400,
			"Invalid attendedDateStrings",
			"Provide an array of ISO dates (YYYY-MM-DD)",
		);
	}

	const invalidDate = requestedDates.find(
		(dateString) => !isValidIsoDate(dateString),
	);

	if (invalidDate) {
		return errorJson(
			"stats-preview",
			400,
			"Invalid date",
			`Invalid ISO date: ${invalidDate}`,
		);
	}

	const db = getDbForEnv(env);
	const attendedDateStrings = await fetchAttendedDateStrings(
		db,
		session.userId,
	);
	const stats = calculateBeltStats(attendedDateStrings.concat(requestedDates));
	return json(stats);
});
app.get("/api/stats", async (c) => {
	const request = c.req.raw;
	const session = await getSessionFromRequest(request, env);
	if (!session) {
		return errorJson(
			"stats",
			401,
			"Authentication required",
			"Log in to access this endpoint",
		);
	}

	const db = getDbForEnv(env);
	const attendedDateStrings = await fetchAttendedDateStrings(
		db,
		session.userId,
	);
	const stats = calculateBeltStats(attendedDateStrings);
	return json(stats, 200);
});

app.all("/api/*", (c) => {
	console.error("[api] Not Found", JSON.stringify({ path: c.req.path }));
	return c.json({ error: "Not Found" }, 404);
});

app.onError((error, c) => {
	console.error("Unhandled error in route handler", error);
	return c.json(
		{
			error: "Unhandled worker route error",
			details: error?.message,
		},
		500,
	);
});

export default app;
