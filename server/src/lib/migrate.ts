import { readdirSync, readFileSync } from "node:fs";
import type { Database } from "./db";

const DIR = new URL("../../migrations/", import.meta.url);

export const migrationNames = () => readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();

// Applies migrations/*.sql in order, each in its own transaction, recording what ran in schema_migrations.
// The files are not safe to replay, so a recorded migration is never run again. Returns what was applied.
export function migrate(db: Database): string[] {
	const sqlite = db.sqlite;
	sqlite.run("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
	const done = new Set(sqlite.query("SELECT name FROM schema_migrations").all().map((r) => (r as { name: string }).name));
	const applied: string[] = [];
	for (const name of migrationNames()) {
		if (done.has(name)) continue;
		const sql = readFileSync(new URL(name, DIR), "utf8");
		sqlite.transaction(() => {
			sqlite.run(sql);
			sqlite.query("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(name, Date.now());
		})();
		applied.push(name);
	}
	return applied;
}
