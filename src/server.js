require("dotenv").config({ quiet: true });
const express = require("express");
const path = require("node:path");

const app = express();
const port = process.env.PORT || 3000;

const workerModulePromise = import("./worker.mjs");

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

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
