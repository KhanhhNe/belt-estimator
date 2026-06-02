const {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} = require("drizzle-orm/sqlite-core");

const users = sqliteTable(
	"users",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		username: text("username").notNull(),
		password: text("password").notNull(),
		uniqueCode: text("unique_code").notNull(),
		isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
	},
	(table) => [
		uniqueIndex("users_username_unique").on(table.username),
		uniqueIndex("users_unique_code_unique").on(table.uniqueCode),
	],
);

const sessions = sqliteTable(
	"sessions",
	{
		sessionId: text("session_id").primaryKey(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id),
		createdAt: integer("created_at").notNull(),
	},
	(table) => [index("sessions_user_id_idx").on(table.userId)],
);

const attendanceRecords = sqliteTable(
	"attendance_records",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		// YYYY-MM-DD
		date: text("date").notNull(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id),
	},
	(table) => [
		uniqueIndex("attendance_records_user_date_unique").on(
			table.userId,
			table.date,
		),
	],
);

module.exports = { attendanceRecords, sessions, users };
