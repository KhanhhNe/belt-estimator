require("dotenv").config({ quiet: true });
const express = require("express");
const { randomUUID } = require("node:crypto");
const { STATUS_CODES } = require("node:http");
const path = require("node:path");

const app = express();
const port = process.env.PORT || 3000;

const workerModulePromise = import("./worker.mjs");

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

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
	const requestId = randomUUID();
	const startedAt = Date.now();
	const startedIso = new Date(startedAt).toISOString();
	const remoteIp =
		req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
		req.socket.remoteAddress ||
		req.ip;
	const format = req.is("application/json") ? "JSON" : "HTML";
	const safeParams = redactRequestBody(req.body ?? {});

	res.locals.requestId = requestId;
	res.setHeader("x-request-id", requestId);

	console.log(
		`[${requestId}] Started ${req.method} "${req.originalUrl}" for ${remoteIp} at ${startedIso}`,
	);
	console.log(`[${requestId}] Processing by WorkerProxy as ${format}`);
	if (Object.keys(safeParams).length > 0) {
		console.log(`[${requestId}]   Parameters: ${JSON.stringify(safeParams)}`);
	}

	res.on("finish", () => {
		const durationMs = Date.now() - startedAt;
		const statusCode = res.statusCode;
		const statusText = STATUS_CODES[statusCode] ?? "Unknown";
		const responseLength = res.getHeader("content-length") ?? "unknown";
		console.log(
			`[${requestId}] Completed ${statusCode} ${statusText} in ${durationMs}ms (Bytes: ${responseLength})`,
		);
	});

	next();
});

function createWorkerEnv() {
	return {
		TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
		TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN,
		PASSWORD_HASH_SECRET: process.env.PASSWORD_HASH_SECRET,
		ASSETS: {
			fetch() {
				return new Response("Not Found", { status: 404 });
			},
		},
	};
}

app.use("/api", async (req, res) => {
	try {
		const workerModule = await workerModulePromise;
		const worker = workerModule.default;
		if (!worker || typeof worker.fetch !== "function") {
			res.status(500).json({ error: "Worker module fetch handler missing" });
			return;
		}

		const requestUrl = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
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
			headers.set("content-type", "application/json");
		}

		if (res.locals.requestId) {
			headers.set("x-request-id", res.locals.requestId);
		}

		const request = new Request(requestUrl, {
			method: req.method,
			headers,
			body,
		});

		const response = await worker.fetch(request, createWorkerEnv());
		res.status(response.status);

		response.headers.forEach((value, key) => {
			if (key.toLowerCase() === "content-length") {
				return;
			}
			res.setHeader(key, value);
		});

		const responseBody = await response.text();
		res.send(responseBody);
	} catch (error) {
		res.status(500).json({
			error: "Failed to route request through worker handler",
			details: error.message,
		});
	}
});

app.listen(port, () => {
	console.log(`Server listening on port ${port}`);
});
