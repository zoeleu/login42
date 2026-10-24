// One-time move from Cloudflare D1 to the service's SQLite file.
//
//   bun scripts/import-d1.ts <dump-dir> <db-path> <expected-audit-head-hash>
//
// <dump-dir> holds one `<table>.json` per table: the raw output of
//   cf d1 query <d1-id> --sql "SELECT * FROM <table>"
// <expected-audit-head-hash> is `head.hash` from GET /admin/v1/logins/verify on the old service, taken after
// writes stopped. The target must be new: it is created, migrated, and filled in a single transaction.
// Exits non-zero, leaving nothing committed, unless every count matches and the audit chain verifies to that head.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyChain } from "../src/lib/audit";
import { openDb, type Database } from "../src/lib/db";
import { migrate } from "../src/lib/migrate";

// Parents before children (foreign keys are enforced). Every application table of schema 0008.
export const TABLES = [
	"users", "bans", "tokens", "limbo_codes", "oauth_states", "rate_limits", "skin_source", "audit_log",
	"web_sessions", "premium_proofs", "mojang_cache", "premium_tokens", "premium_accounts",
	"login_audit", "login_audit_erasure",
] as const;

type Row = Record<string, string | number | null>;

export function readDump(dir: string): Record<string, Row[]> {
	const out: Record<string, Row[]> = {};
	for (const t of TABLES) {
		const parsed = JSON.parse(readFileSync(join(dir, `${t}.json`), "utf8")) as { results?: Row[] }[];
		if (!Array.isArray(parsed) || parsed.length !== 1 || !Array.isArray(parsed[0].results)) throw new Error(`${t}.json is not a single cf d1 query result`);
		out[t] = parsed[0].results;
	}
	return out;
}

export async function importDump(db: Database, dump: Record<string, Row[]>, expectedHead: string): Promise<Record<string, number>> {
	const sqlite = db.sqlite;
	for (const t of TABLES) {
		if ((sqlite.query(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n > 0) throw new Error(`target table ${t} is not empty; refusing to import over it`);
	}
	const counts: Record<string, number> = {};
	sqlite.run("BEGIN IMMEDIATE");
	try {
		for (const t of TABLES) {
			for (const row of dump[t]) {
				const cols = Object.keys(row);
				sqlite.query(`INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => row[c]));
			}
			counts[t] = (sqlite.query(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
			if (counts[t] !== dump[t].length) throw new Error(`${t}: imported ${counts[t]} rows, dump has ${dump[t].length}`);
		}
		const chain = await verifyChain(db);
		if (!chain.ok) throw new Error(`audit chain does not verify: ${JSON.stringify(chain.error)}`);
		const head = chain.head?.hash ?? null;
		if (head !== (expectedHead || null)) throw new Error(`audit head ${head} does not match the expected ${expectedHead}`);
		sqlite.run("COMMIT");
	} catch (e) {
		sqlite.run("ROLLBACK");
		throw e;
	}
	return counts;
}

if (import.meta.main) {
	const [dir, dbPath, expectedHead] = process.argv.slice(2);
	if (!dir || !dbPath || expectedHead === undefined) {
		console.error("usage: bun scripts/import-d1.ts <dump-dir> <db-path> <expected-audit-head-hash>");
		process.exit(2);
	}
	if (existsSync(dbPath)) {
		console.error(`${dbPath} already exists; import only into a new file`);
		process.exit(2);
	}
	const db = openDb(dbPath);
	migrate(db);
	const counts = await importDump(db, readDump(dir), expectedHead);
	db.sqlite.close();
	console.log(JSON.stringify({ ok: true, counts }));
}
