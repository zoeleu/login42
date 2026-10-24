import { Database as SQLite, type SQLQueryBindings } from "bun:sqlite";

// The slice of Cloudflare D1's API this service was written against, implemented over bun:sqlite so route
// code keeps its shape. Calls stay async; batch() is a real transaction (all statements or none).

type Row = Record<string, unknown>;

export interface RunResult {
	success: true;
	meta: { changes: number; last_row_id: number };
}

export class Statement {
	constructor(
		private readonly db: SQLite,
		private readonly sql: string,
		private readonly params: SQLQueryBindings[] = [],
	) {}

	bind(...values: unknown[]): Statement {
		// D1 rejects undefined; treat it as NULL rather than failing on optional fields.
		return new Statement(this.db, this.sql, values.map((v) => (v === undefined ? null : v)) as SQLQueryBindings[]);
	}

	/** Synchronous execution, used directly by batch() inside its transaction. */
	runSync(): RunResult {
		const r = this.db.query(this.sql).run(...this.params);
		return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
	}

	async first<T = Row>(): Promise<T | null> {
		return (this.db.query(this.sql).get(...this.params) as T | null) ?? null;
	}

	async all<T = Row>(): Promise<{ results: T[] }> {
		return { results: this.db.query(this.sql).all(...this.params) as T[] };
	}

	async run(): Promise<RunResult> {
		return this.runSync();
	}
}

export class Database {
	constructor(readonly sqlite: SQLite) {}

	prepare(sql: string): Statement {
		return new Statement(this.sqlite, sql);
	}

	async batch(statements: Statement[]): Promise<RunResult[]> {
		return this.sqlite.transaction(() => statements.map((s) => s.runSync()))();
	}
}

export function openDb(path: string): Database {
	const sqlite = new SQLite(path, { create: true });
	sqlite.run("PRAGMA journal_mode = WAL");
	sqlite.run("PRAGMA busy_timeout = 5000");
	// D1 enforces foreign keys; the schema's unlink/delete semantics rely on it.
	sqlite.run("PRAGMA foreign_keys = ON");
	return new Database(sqlite);
}
