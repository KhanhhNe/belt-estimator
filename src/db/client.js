require("dotenv").config();
const { createClient } = require("@libsql/client");
const { drizzle } = require("drizzle-orm/libsql");

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url || !authToken) {
	throw new Error(
		"Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN in environment",
	);
}

const client = createClient({
	url,
	authToken,
});

const db = drizzle({ client });

module.exports = { client, db };
