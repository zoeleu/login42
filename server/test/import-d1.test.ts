// The D1 -> SQLite move: a dump in `cf d1 query` output format round-trips with the audit chain intact.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordLogin, verifyChain } from "../src/lib/audit";
import { openDb } from "../src/lib/db";
import { migrate } from "../src/lib/migrate";
import { ftIdToUuid } from "../src/lib/uuid";
import { importDump, readDump, TABLES } from "../scripts/import-d1";

async function source() {
	const db = openDb(":memory:");
	migrate(db);
	db.sqlite.query("INSERT INTO users (ft_id, login, uuid, mc_name, created_at, special_title) VALUES (42, 'jdoe', ?, 'jdoe', 1, NULL)").run(ftIdToUuid(42));
	db.sqlite.query("INSERT INTO premium_accounts (ft_id, mojang_uuid, verified_at) VALUES (42, ?, 2)").run("ab".repeat(16));
	db.sqlite.query("INSERT INTO bans (ft_id, reason, source, created_at) VALUES (42, 'r', 'admin', 3)").run();
	await recordLogin(db, { event: "oauth_web", ft_id: 42, login: "jdoe", mc_name: "jdoe", ip: "2001:db8::1", ip_source: "browser", user_agent: "UA" });
	await recordLogin(db, { event: "game_login", ft_id: 42, login: "jdoe", mc_name: "jdoe", ip: "192.0.2.1", ip_source: "game", token_hash: "c".repeat(64) });
	// What `cf d1 query` prints: one result set per statement. D1's tables have no up_to_id column yet.
	const dir = mkdtempSync(join(tmpdir(), "login42-dump-"));
	for (const t of TABLES) {
		const rows = db.sqlite.query(`SELECT * FROM ${t}`).all() as Record<string, unknown>[];
		if (t === "login_audit_erasure") rows.forEach((r) => delete r.up_to_id);
		writeFileSync(join(dir, `${t}.json`), JSON.stringify([{ results: rows, success: true, meta: {} }]));
	}
	return { dir, head: (await verifyChain(db)).head!.hash };
}

describe("D1 import", () => {
	it("copies every table and keeps the audit chain verifying to the same head", async () => {
		const { dir, head } = await source();
		const target = openDb(":memory:");
		migrate(target);
		const counts = await importDump(target, readDump(dir), head);
		expect(counts).toMatchObject({ users: 1, bans: 1, premium_accounts: 1, login_audit: 2 });
		expect(await verifyChain(target)).toMatchObject({ ok: true, rows: 2, head: { hash: head } });
		// AUTOINCREMENT continues after the imported ids, so the chain extends normally.
		expect((await recordLogin(target, { event: "game_login", ft_id: 42 })).id).toBe(3);
		expect((await verifyChain(target)).ok).toBe(true);
	});

	it("commits nothing when the head differs from the old service's, or the target is not empty", async () => {
		const { dir, head } = await source();
		const target = openDb(":memory:");
		migrate(target);
		await expect(importDump(target, readDump(dir), "f".repeat(64))).rejects.toThrow(/does not match/);
		expect(target.sqlite.query("SELECT count(*) AS n FROM users").get()).toEqual({ n: 0 });
		await importDump(target, readDump(dir), head);
		await expect(importDump(target, readDump(dir), head)).rejects.toThrow(/not empty/);
	});
});
