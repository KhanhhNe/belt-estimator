const {
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} = require("drizzle-orm/sqlite-core");

const attendanceRecords = sqliteTable(
	"attendance_records",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		// YYYY-MM-DD
		date: text("date").notNull(),
	},
	(table) => [uniqueIndex("attendance_records_date_unique").on(table.date)],
);

module.exports = { attendanceRecords };
