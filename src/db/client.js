const { createClient } = require("@libsql/client");
const { drizzle } = require("drizzle-orm/libsql");

/**
 * @typedef {object} DatabaseCredentials
 * @property {string} url
 * @property {string} authToken
 */

/**
 * @typedef {NodeJS.ProcessEnv & {
 * 	TURSO_DATABASE_URL?: string;
 * 	TURSO_AUTH_TOKEN?: string;
 * }} EnvLike
 */

/**
 * @typedef {object} DbClientBundle
 * @property {import("@libsql/client").Client} client
 * @property {import("drizzle-orm/libsql").LibSQLDatabase} db
 */

/**
 * @param {EnvLike} [env]
 * @returns {DatabaseCredentials}
 */
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

/**
 * @param {DatabaseCredentials} params
 * @returns {DbClientBundle}
 */
function createDbClient({ url, authToken }) {
	const client = createClient({
		url,
		authToken,
	});

	const db = drizzle({ client });

	return { client, db };
}

/**
 * @param {EnvLike} [env]
 * @returns {DbClientBundle}
 */
function getDbFromEnv(env = process.env) {
	const credentials = getDatabaseCredentials(env);
	return createDbClient(credentials);
}

const { client, db } = getDbFromEnv(process.env);

module.exports = { client, db, createDbClient, getDbFromEnv };
