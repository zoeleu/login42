// The Bun runtime layer: database adapter, migrations and startup configuration.
import { describe, expect, it } from "bun:test";
import { openDb } from "../src/lib/db";
import { migrate, migrationNames } from "../src/lib/migrate";
import { loadEnv } from "../src/server";

describe("database adapter", () => {
	it("applies a batch as one transaction: a failing statement rolls back the others", async () => {
		const db = openDb(":memory:");
		migrate(db);
		await expect(db.batch([
			db.prepare("INSERT INTO users (ft_id, login, uuid, mc_name, created_at) VALUES (1, 'a', 'u1', 'a', 1)"),
			db.prepare("INSERT INTO users (ft_id, login, uuid, mc_name, created_at) VALUES (2, 'b', 'u1', 'b', 1)"), // duplicate uuid
		])).rejects.toThrow(/UNIQUE/);
		expect((await db.prepare("SELECT count(*) AS n FROM users").first<{ n: number }>())?.n).toBe(0);
	});

	it("matches D1's result shapes and binds undefined as NULL", async () => {
		const db = openDb(":memory:");
		migrate(db);
		const r = await db.prepare("INSERT INTO audit_log (at, ft_id, action, detail) VALUES (?, ?, 'x', ?)").bind(1, undefined, null).run();
		expect(r.meta.changes).toBe(1);
		expect(await db.prepare("SELECT ft_id FROM audit_log").first()).toEqual({ ft_id: null });
		expect(await db.prepare("SELECT 1 FROM users").first()).toBeNull();
		expect(await db.prepare("SELECT 1 FROM users").all()).toEqual({ results: [] });
	});

	it("enforces foreign keys, as D1 does", async () => {
		const db = openDb(":memory:");
		migrate(db);
		await expect(db.prepare("INSERT INTO bans (ft_id, created_at) VALUES (99, 1)").run()).rejects.toThrow(/FOREIGN KEY/);
	});
});

describe("migrations", () => {
	it("apply every file once and never replay a recorded one", () => {
		const db = openDb(":memory:");
		expect(migrate(db)).toEqual(migrationNames());
		expect(migrate(db)).toEqual([]);
		expect(db.sqlite.query("SELECT count(*) AS n FROM schema_migrations").get()).toEqual({ n: migrationNames().length });
	});
});

describe("startup configuration", () => {
	const complete = { PUBLIC_URL: "https://x", FT_CLIENT_ID: "a", FT_CLIENT_SECRET: "b", PLUGIN_HMAC_SECRET: "c", ADMIN_TOKEN: "d" };

	it("refuses to start without the secrets authentication depends on", () => {
		for (const key of Object.keys(complete)) {
			expect(() => loadEnv({ ...complete, [key]: "" })).toThrow(key);
		}
	});

	it("fills optional settings with safe defaults and ignores unrelated variables", () => {
		const env = loadEnv({ ...complete, LIMBO_PER_MINUTE: "5", PATH: "/bin" }) as unknown as Record<string, string>;
		expect(env).toMatchObject({ LIMBO_PER_MINUTE: "5", TOKEN_TTL_SECONDS: "120", ALLOW_STAFF: "false", MINESKIN_API_KEY: "" });
		expect(env.PATH).toBeUndefined();
	});
});
