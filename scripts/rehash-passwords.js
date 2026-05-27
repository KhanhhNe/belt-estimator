require("dotenv").config({ quiet: true });

const bcrypt = require("bcryptjs");
const { client } = require("../src/db/client");

const BCRYPT_HASH_PREFIX = /^\$2[aby]\$\d{2}\$/;
const BCRYPT_SALT_ROUNDS = 10;

function getPasswordHashSecret(env = process.env) {
	const secret = env.PASSWORD_HASH_SECRET;
	if (!secret) {
		throw new Error("Missing PASSWORD_HASH_SECRET in environment");
	}

	return secret;
}

async function hashPassword(password, secret) {
	return bcrypt.hash(`${password}${secret}`, BCRYPT_SALT_ROUNDS);
}

async function rehashPlaintextPasswords() {
	const secret = getPasswordHashSecret();
	const usersResult = await client.execute(
		"SELECT id, username, password FROM users ORDER BY id",
	);
	const rows = usersResult.rows ?? [];

	let rehashed = 0;
	let skipped = 0;

	for (const row of rows) {
		const password = String(row.password ?? "");
		if (BCRYPT_HASH_PREFIX.test(password)) {
			skipped += 1;
			continue;
		}

		const passwordHash = await hashPassword(password, secret);
		await client.execute({
			sql: "UPDATE users SET password = ? WHERE id = ?",
			args: [passwordHash, row.id],
		});
		rehashed += 1;
	}

	return { total: rows.length, rehashed, skipped };
}

async function main() {
	const summary = await rehashPlaintextPasswords();
	console.log(JSON.stringify(summary));
}

main().catch((error) => {
	console.error("Failed to rehash existing passwords:", error);
	process.exit(1);
});
