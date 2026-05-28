import { httpServerHandler } from "cloudflare:node";
import { env } from "cloudflare:workers";
import { createClient } from "@libsql/client/web";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import express from "express";
import schema from "./db/schema.js";
import beltStats from "./services/beltStats.js";

const { attendanceRecords, sessions, users } = schema;
const { getBeltStats, getBeltStatsFromAttendedDateStrings } = beltStats;
const UNIQUE_CODE_LENGTH = 8;
const UNIQUE_CODE_CHARSET =
	"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const BCRYPT_SALT_ROUNDS = 10;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);

let cachedDb = null;
let cachedCredentialsKey = null;
const SESSION_COOKIE_NAME = "belt_sid";

const API_DOCS = {
	recordAttendance:
		"POST /api/record-attendance records today's date (UTC+7) for the user identified by header User-Unique-Code.",
	authRegister:
		"POST /api/auth/register with { username, password } creates an account and starts a session.",
	authLogin:
		"POST /api/auth/login with { username, password } starts a session.",
	authLogout: "POST /api/auth/logout clears the current session.",
	authMe: "GET /api/auth/me returns current session user info.",
	authForgotPasswordHash:
		"POST /api/auth/forgot-password-hash with { username, newPassword } returns a bcrypt hash to share with Khanh Luong for manual reset.",
	previewStats:
		"POST /api/stats/preview accepts attendedDateStrings (array of YYYY-MM-DD) and returns recomputed BELT stats without writing to database.",
	stats:
		"GET /api/stats requires an authenticated session and returns stats for the current session user.",
};

const app = express();
app.use(express.json());

function redactRequestBody(value) {
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

app.use("/api", (req, res, next) => {
	const startedAt = Date.now();
	const startedIso = new Date(startedAt).toISOString();
	const remoteIp =
		req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
		req.socket.remoteAddress ||
		req.ip;
	const format = req.is("application/json") ? "JSON" : "HTML";
	const safeParams = redactRequestBody(req.body ?? {});

	console.log(
		`Started ${req.method} "${req.originalUrl}" for ${remoteIp} at ${startedIso}`,
	);
	console.log(`Processing by Worker as ${format}`);
	if (Object.keys(safeParams).length > 0) {
		console.log(`Parameters: ${JSON.stringify(safeParams)}`);
	}

	res.on("finish", () => {
		const durationMs = Date.now() - startedAt;
		const statusCode = res.statusCode;
		const responseLength = res.getHeader("content-length") ?? "unknown";
		console.log(
			`Completed ${statusCode} in ${durationMs}ms (Bytes: ${responseLength})`,
		);
	});

	next();
});

function getExpressRequestUrl(req) {
	const host = req.headers.host ?? "localhost";
	return new URL(req.originalUrl, `https://${host}`).toString();
}

function createWorkerRequestFromExpress(req) {
	const headers = new Headers();
	for (const [key, value] of Object.entries(req.headers)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				headers.append(key, item);
			}
			continue;
		}

		if (value !== undefined) {
			headers.set(key, String(value));
		}
	}

	let body;
	if (req.method !== "GET" && req.method !== "HEAD") {
		body = JSON.stringify(req.body ?? {});
		if (!headers.has("content-type")) {
			headers.set("content-type", "application/json");
		}
	}

	return new Request(getExpressRequestUrl(req), {
		method: req.method,
		headers,
		body,
	});
}

async function sendWorkerResponseToExpress(res, response) {
	res.status(response.status);

	response.headers.forEach((value, key) => {
		if (key.toLowerCase() === "content-length") {
			return;
		}
		res.setHeader(key, value);
	});

	res.send(await response.text());
}

function routeHandler(handler) {
	return async (req, res) => {
		try {
			const request = createWorkerRequestFromExpress(req);
			const response = await handler(request);
			await sendWorkerResponseToExpress(res, response);
		} catch (error) {
			res.status(500).json({
				error: "Unhandled worker route error",
				details: error?.message,
			});
		}
	};
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
		},
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

async function handleRecordAttendance(env, request) {
	const requestStartedAt = Date.now();
	const requestUrl = new URL(request.url);
	const logPrefix = "[record-attendance]";

	try {
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
			console.warn(
				`${logPrefix} Missing User-Unique-Code header after ${Date.now() - requestStartedAt}ms`,
			);
			return json(
				{
					error: "Missing User-Unique-Code",
					details:
						"Provide header User-Unique-Code with a valid user unique code",
				},
				401,
			);
		}

		const matchedUsers = await db
			.select({ id: users.id, username: users.username })
			.from(users)
			.where(eq(users.uniqueCode, userUniqueCode))
			.limit(1);

		const matchedUser = matchedUsers[0];
		if (!matchedUser) {
			console.warn(
				`${logPrefix} Invalid unique code`,
				JSON.stringify({
					uniqueCodeHint: maskUniqueCode(userUniqueCode),
					durationMs: Date.now() - requestStartedAt,
				}),
			);
			return json(
				{
					error: "Invalid User-Unique-Code",
					details: "The provided unique code does not match any user",
				},
				403,
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
	} catch (error) {
		console.error(
			`${logPrefix} Failed to record attendance`,
			JSON.stringify({
				durationMs: Date.now() - requestStartedAt,
				errorMessage: error?.message,
				stack: error?.stack,
			}),
		);
		return json(
			{
				error: "Failed to record attendance",
				details: error.message,
			},
			500,
		);
	}
}

async function handleRegister(request, env) {
	try {
		const body = await request.json();
		const username = `${body?.username ?? ""}`.trim();
		const password = `${body?.password ?? ""}`;

		if (!username || !password) {
			return json(
				{
					error: "Invalid payload",
					details: "username and password are required",
				},
				400,
			);
		}

		const db = getDbForEnv(env);
		const existingUsers = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.username, username))
			.limit(1);

		if (existingUsers.length > 0) {
			return json(
				{
					error: "Username already exists",
					details: "Choose another username",
				},
				409,
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
	} catch (error) {
		return json(
			{
				error: "Failed to register",
				details: error.message,
			},
			500,
		);
	}
}

async function handleLogin(request, env) {
	try {
		const body = await request.json();
		const username = `${body?.username ?? ""}`.trim();
		const password = `${body?.password ?? ""}`;

		if (!username || !password) {
			return json(
				{
					error: "Invalid payload",
					details: "username and password are required",
				},
				400,
			);
		}

		const db = getDbForEnv(env);
		const matchedUsers = await db
			.select({
				id: users.id,
				username: users.username,
				password: users.password,
				uniqueCode: users.uniqueCode,
			})
			.from(users)
			.where(eq(users.username, username))
			.limit(1);

		const matchedUser = matchedUsers[0];
		if (!matchedUser) {
			return json(
				{
					error: "Invalid credentials",
					details: "Incorrect username or password",
				},
				401,
			);
		}

		const isPasswordValid = await verifyPassword(
			password,
			matchedUser.password,
			env,
		);
		if (!isPasswordValid) {
			return json(
				{
					error: "Invalid credentials",
					details: "Incorrect username or password",
				},
				401,
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
	} catch (error) {
		return json(
			{
				error: "Failed to login",
				details: error.message,
			},
			500,
		);
	}
}

async function handleLogout(request, env) {
	const session = await getSessionFromRequest(request, env);
	if (session) {
		await deleteSessionById(session.id, env);
	}

	return withClearedSessionCookie({
		authenticated: false,
		message: "Logged out",
	});
}

async function handleAuthMe(request, env) {
	try {
		const session = await getSessionFromRequest(request, env);
		if (!session) {
			return json(buildAuthResponse(null));
		}

		const db = getDbForEnv(env);
		const matchedUsers = await db
			.select({
				id: users.id,
				username: users.username,
				uniqueCode: users.uniqueCode,
			})
			.from(users)
			.where(eq(users.id, session.userId))
			.limit(1);

		const matchedUser = matchedUsers[0];
		if (!matchedUser) {
			await deleteSessionById(session.id, env);
			return withClearedSessionCookie(buildAuthResponse(null));
		}

		return withSessionCookie(
			buildAuthResponse(session, matchedUser),
			session.id,
		);
	} catch (error) {
		return json(
			{
				error: "Failed to load auth state",
				details: error.message,
			},
			500,
		);
	}
}

async function handleForgotPasswordHash(request, env) {
	try {
		const body = await request.json();
		const username = `${body?.username ?? ""}`.trim();
		const newPassword = `${body?.newPassword ?? ""}`;

		if (!username || !newPassword) {
			return json(
				{
					error: "Invalid payload",
					details: "username and newPassword are required",
				},
				400,
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
			return json(
				{
					error: "User not found",
					details: "No user exists with the provided username",
				},
				404,
			);
		}

		const passwordHash = await hashPassword(newPassword, env);
		return json({
			username: matchedUser.username,
			passwordHash,
			hint: "Send this username and password hash to Khanh Luong for manual password reset.",
		});
	} catch (error) {
		return json(
			{
				error: "Failed to generate password hash",
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

async function handleStats(request, env) {
	try {
		const session = await getSessionFromRequest(request, env);
		if (!session) {
			return json(
				{
					error: "Authentication required",
					details: "Log in to access this endpoint",
				},
				401,
			);
		}

		const db = getDbForEnv(env);
		const stats = await getBeltStats(db, session.userId);
		return json(
			{
				_docs: API_DOCS,
				auth: {
					authenticated: true,
					userId: session.userId,
					username: session.username,
				},
				...stats,
			},
			200,
		);
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
app.get("/", (_req, res) => {
	res.json({ message: "Express.js running on Cloudflare Workers!" });
});

app.post(
	"/api/auth/register",
	routeHandler((request) => handleRegister(request, env)),
);
app.post(
	"/api/auth/login",
	routeHandler((request) => handleLogin(request, env)),
);
app.post(
	"/api/auth/logout",
	routeHandler((request) => handleLogout(request, env)),
);
app.get(
	"/api/auth/me",
	routeHandler((request) => handleAuthMe(request, env)),
);
app.post(
	"/api/auth/forgot-password-hash",
	routeHandler((request) => handleForgotPasswordHash(request, env)),
);
app.post(
	"/api/record-attendance",
	routeHandler((request) => handleRecordAttendance(env, request)),
);
app.post(
	"/api/stats/preview",
	routeHandler((request) => handlePreviewStats(request)),
);
app.get(
	"/api/stats",
	routeHandler((request) => handleStats(request, env)),
);

app.use("/api", (_req, res) => {
	res.status(404).json({ error: "Not Found" });
});

app.listen(3000);

export default httpServerHandler({ port: 3000 });
