const { createClient } = require("@libsql/client");
const { drizzle } = require("drizzle-orm/libsql");

function getDatabaseCredentials(env = process.env) {
	const url = env.TURSO_DATABASE_URL;
	const authToken = env.TURSO_AUTH_TOKEN;

	if (!url || !authToken) {
		throw new Error(
			"Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN in environment",
		);
	}

	return { url, authToken };
}

function createDbClient({ url, authToken }) {
	const client = createClient({
		url,
		authToken,
	});

	const db = drizzle({ client });

	return { client, db };
}

function getDbFromEnv(env = process.env) {
	const credentials = getDatabaseCredentials(env);
	return createDbClient(credentials);
}

const { client, db } = getDbFromEnv(process.env);

module.exports = { client, db, createDbClient, getDbFromEnv };
