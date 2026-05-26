require("dotenv").config();
const { defineConfig } = require("drizzle-kit");

module.exports = defineConfig({
	out: "./drizzle",
	schema: "./src/db/schema.js",
	dialect: "turso",
	dbCredentials: {
		url: process.env.TURSO_DATABASE_URL,
		authToken: process.env.TURSO_AUTH_TOKEN,
	},
});
