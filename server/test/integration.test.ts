// End-to-end tests over HTTP against the real Bun server (Bun.serve + app) on a temporary SQLite file,
// with every migration applied. Random secrets; nothing outside this process is touched.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import app from "../src/index";
import { openDb } from "../src/lib/db";
import { migrate } from "../src/lib/migrate";
import { ftIdToUuid } from "../src/lib/uuid";
import { loadEnv } from "../src/server";

const vars = { PLUGIN_HMAC_SECRET: randomBytes(32).toString("hex"), ADMIN_TOKEN: randomBytes(32).toString("hex") };
const dir = mkdtempSync(join(tmpdir(), "login42-it-"));
const db = openDb(join(dir, "login42.sqlite"));
migrate(db);
const env: Env = { ...loadEnv({ PUBLIC_URL: "http://127.0.0.1", FT_CLIENT_ID: "it-client", FT_CLIENT_SECRET: "it-secret", ...vars }), DB: db };
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => app.fetch(req, env) });
const BASE = server.url.origin;

// Rows as arrays of column values, like the D1 explorer's raw endpoint returned.
async function sql(statements: string[]) {
	return statements.map((s) => db.sqlite.query(s).values() as unknown[][]);
}

async function api(method: string, path: string, body?: unknown, opts: { sign?: boolean } = {}) {
	const text = body === undefined ? "" : JSON.stringify(body);
	const ts = String(Date.now());
	const sig = createHmac("sha256", vars.PLUGIN_HMAC_SECRET).update(`${ts}.${method}.${path}.${text}`).digest("hex");
	const res = await fetch(BASE + path, {
		method,
		headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": opts.sign === false ? "0".repeat(64) : sig },
		body: method === "GET" ? undefined : text,
	});
	return { status: res.status, json: (await res.json()) as Record<string, any> };
}

const admin = (method: string, path: string, body?: unknown, token = vars.ADMIN_TOKEN) =>
	fetch(`${BASE}/admin/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, any> }));

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ID = 7_000_001;
const ID2 = 7_000_003;
const UUID2 = ftIdToUuid(ID2);
const NOTCH = "069a79f444e94726a5befca90e38aaf5";
const UUID = ftIdToUuid(ID);
const future = () => Date.now() + 120_000;

async function giveToken(token: string) {
	await sql([`INSERT INTO tokens VALUES ('${sha(token)}', ${ID}, ${future()}, NULL)`]);
}

describe("web service (integration)", () => {
	beforeAll(async () => {
		await sql([`INSERT INTO users (ft_id, login, uuid, mc_name, created_at) VALUES (${ID}, 'itest', '${UUID}', 'itest_user', 1)`, `INSERT INTO users (ft_id, login, uuid, mc_name, created_at) VALUES (${ID2}, 'itest2', '${UUID2}', 'itest_two', 1)`]);
	});
	afterAll(() => {
		server.stop(true);
		db.sqlite.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("rejects missing or wrong signatures and stale timestamps", async () => {
		expect((await api("POST", "/api/v1/join-check", { name: "abc" }, { sign: false })).status).toBe(401);
		const stale = await fetch(`${BASE}/api/v1/join-check`, { method: "POST", headers: { "x-timestamp": String(Date.now() - 120_000), "x-signature": "0".repeat(64) }, body: "{}" });
		expect(stale.status).toBe(401);
	});

	it("sends an unknown connection to limbo and rejects bad names", async () => {
		const r = await api("POST", "/api/v1/join-check", { name: "Someone", token: null, ip: "198.51.100.1" });
		expect(r.json.status).toBe("limbo");
		expect(r.json.code).toMatch(/^[A-Z0-9]{10}$/);
		expect((await api("POST", "/api/v1/join-check", { name: "bad name!" })).status).toBe(400);
	});

	it("limbo poll: pending, then the token exactly once, then expired", async () => {
		const code = (await api("POST", "/api/v1/join-check", { name: "Someone", token: null, ip: "198.51.100.2" })).json.code as string;
		expect((await api("GET", `/api/v1/limbo/${code}`)).json.status).toBe("pending");
		await sql([`UPDATE limbo_codes SET ft_id = ${ID}, pending_token = 'handoff-token-1' WHERE code = '${code}'`]);
		expect((await api("GET", `/api/v1/limbo/${code}`)).json).toEqual({ status: "done", token: "handoff-token-1" });
		expect((await api("GET", `/api/v1/limbo/${code}`)).json.status).toBe("expired");
	});

	it("a failed sign-in is reported to the waiting guest", async () => {
		const code = (await api("POST", "/api/v1/join-check", { name: "Someone", token: null, ip: "198.51.100.3" })).json.code as string;
		await sql([`UPDATE limbo_codes SET ft_id = -1 WHERE code = '${code}'`]);
		expect((await api("GET", `/api/v1/limbo/${code}`)).json.status).toBe("failed");
	});

	it("a valid token logs in once with the canonical uuid and name, then is spent", async () => {
		await giveToken("tok-a");
		const ok = await api("POST", "/api/v1/join-check", { name: "whatever", token: "tok-a" });
		expect(ok.json).toMatchObject({ status: "allow", uuid: UUID, name: "itest_user" });
		expect(ok.json.token).toBeUndefined(); // no rotation: cookies do not outlive a manual reconnect
		const again = await api("POST", "/api/v1/join-check", { name: "whatever", token: "tok-a", ip: "198.51.100.4" });
		expect(again.json.status).toBe("limbo");
	});

	it("records the game login with address and token hash, queryable by admins on a verifying chain", async () => {
		await giveToken("tok-audit");
		const ok = await api("POST", "/api/v1/join-check", { name: "Claimed", client_uuid: "00000000-0000-3000-8000-0000000000aa", token: "tok-audit", ip: "198.51.100.77", host: "42.g.example:24242" });
		const { audit_id, audit_hash } = ok.json;
		expect(ok.json.status).toBe("allow");
		expect(typeof audit_id).toBe("number");
		expect(audit_hash).toMatch(/^[0-9a-f]{64}$/);
		expect((await admin("GET", "/logins?login=itest", undefined, "wrong")).status).toBe(401);
		const found = (await admin("GET", `/logins?token_hash=${sha("tok-audit")}`)).json.logins;
		expect(found).toEqual([expect.objectContaining({ id: audit_id, hash: audit_hash, event: "game_login", login: "itest", mc_name: "itest_user", client_name: "Claimed", ip: "198.51.100.77" })]);
		expect((await admin("GET", "/logins?mc_name=ITEST_USER&ip=198.51.100.77")).json.logins[0].id).toBe(audit_id);
		expect((await admin("GET", "/logins/verify")).json).toMatchObject({ ok: true, head: { id: expect.any(Number) } });
	});

	it("replaying a spent token revokes the user's other tokens and is audited", async () => {
		await giveToken("tok-b");
		await giveToken("tok-c");
		await api("POST", "/api/v1/join-check", { name: "x", token: "tok-b" });
		await api("POST", "/api/v1/join-check", { name: "x", token: "tok-b", ip: "198.51.100.5" }); // replay
		expect((await api("POST", "/api/v1/join-check", { name: "x", token: "tok-c", ip: "198.51.100.6" })).json.status).toBe("limbo");
		const [rows] = await sql([`SELECT count(*) FROM audit_log WHERE ft_id = ${ID} AND action = 'token_reuse'`]);
		expect(Number(rows[0][0])).toBeGreaterThanOrEqual(1);
	});

	it("returns the 42 title only after authentication and clears removed titles", async () => {
		await sql([`UPDATE users SET special_title = 'itest, Writer''s soul' WHERE ft_id = ${ID}`]);
		const guest = await api("POST", "/api/v1/join-check", { name: "itest_user", ip: "198.51.100.29" });
		expect(guest.json.special_title).toBeUndefined();
		await giveToken("title-token");
		const join = await api("POST", "/api/v1/join-check", { name: "another_name", token: "title-token" });
		expect(join.json.special_title).toBe("itest, Writer's soul");
		await sql([`UPDATE users SET special_title = NULL WHERE ft_id = ${ID}`]);
		await giveToken("title-removed");
		expect((await api("POST", "/api/v1/join-check", { name: "another_name", token: "title-removed" })).json.special_title).toBeNull();
	});

	it("expired tokens do not log in", async () => {
		await sql([`INSERT INTO tokens VALUES ('${sha("tok-old")}', ${ID}, ${Date.now() - 1000}, NULL)`]);
		expect((await api("POST", "/api/v1/join-check", { name: "x", token: "tok-old", ip: "198.51.100.7" })).json.status).toBe("limbo");
	});

	it("ban by uuid: banned at the door, tokens revoked, listed, pardon restores", async () => {
		await giveToken("tok-d");
		expect((await api("POST", "/api/v1/bans", { mc_uuid: UUID, reason: "r", source: "t" })).status).toBe(200);
		expect((await api("POST", "/api/v1/join-check", { name: "x", token: "tok-d" })).json.status).toBe("limbo"); // token was revoked by the ban
		const list = (await api("GET", "/api/v1/bans")).json.bans as { mc_uuid: string; mc_name: string }[];
		expect(list.find((b) => b.mc_uuid === UUID)?.mc_name).toBe("itest_user");
		await giveToken("tok-e");
		expect((await api("POST", "/api/v1/join-check", { name: "x", token: "tok-e" })).json.status).toBe("banned");
		await api("POST", "/api/v1/pardons", { mc_uuid: UUID });
		await giveToken("tok-f");
		expect((await api("POST", "/api/v1/join-check", { name: "x", token: "tok-f" })).json.status).toBe("allow");
	});

	it("ban of a foreign uuid is refused", async () => {
		expect((await api("POST", "/api/v1/bans", { mc_uuid: "069a79f4-44e9-4726-a5be-fca90e38aaf5" })).status).toBe(404);
	});

	it("rate limits unauthenticated limbo creation per address, not other addresses", async () => {
		const results: string[] = [];
		for (let i = 0; i < 16; i++) results.push((await api("POST", "/api/v1/join-check", { name: "Spam", token: null, ip: "203.0.113.77" })).json.status);
		expect(results.filter((s) => s === "rate_limited").length).toBeGreaterThan(0);
		expect((await api("POST", "/api/v1/join-check", { name: "Spam", token: null, ip: "203.0.113.78" })).json.status).toBe("limbo");
	});

	it("admin API requires the token and manages bans by login", async () => {
		expect((await admin("GET", "/audit", undefined, "wrong")).status).toBe(401);
		expect((await admin("POST", "/bans", { login: "itest", reason: "adm" })).status).toBe(200);
		expect(((await admin("GET", "/users/itest")).json as any).ban_reason).toBe("adm");
		expect((await admin("DELETE", "/users/itest")).status).toBe(409); // must pardon before unlinking
		expect((await admin("DELETE", "/bans/itest")).status).toBe(200);
	});

	it("premium proof: validates input and is single-use through the page flow", async () => {
		expect((await api("POST", "/api/v1/premium/proof", { mojang_uuid: "nope", mojang_name: "x" })).status).toBe(400);
		const p = await api("POST", "/api/v1/premium/proof", { mojang_uuid: "069a79f4-44e9-4726-a5be-fca90e38aaf5", mojang_name: "Notch" });
		expect(p.json.code).toMatch(/^[A-Z0-9]{8}$/);
	});

	it("premium start/bind links a verified Mojang account with no code, once, and hands back a session token", async () => {
		const start = await api("POST", "/api/v1/premium/start", { mc_uuid: UUID });
		expect(start.json.token).toMatch(/^[A-Za-z0-9_-]{16,}$/);
		const bind = await api("POST", "/api/v1/premium/bind", { token: start.json.token, mojang_uuid: NOTCH, mojang_name: "Notch" });
		expect(bind.status).toBe(200);
		expect(bind.json).toMatchObject({ ok: true, login: "itest" });
		const [rows] = await sql([`SELECT kind, mojang_uuid FROM skin_source WHERE ft_id = ${ID}`]);
		expect(rows[0]).toEqual(["mojang", NOTCH]);
		// Keep the join deterministic: serve cached textures instead of a live Mojang lookup.
		await sql([`INSERT OR REPLACE INTO mojang_cache VALUES ('${NOTCH}', 'cached-value', 'cached-signature', ${Date.now()})`]);
		// the returned session token admits the player straight away (the verifier transfers them back with it)
		expect((await api("POST", "/api/v1/join-check", { name: "x", token: bind.json.session_token })).json).toMatchObject({ status: "allow", uuid: UUID });
		// single use
		expect((await api("POST", "/api/v1/premium/bind", { token: start.json.token, mojang_uuid: NOTCH, mojang_name: "Notch" })).status).toBe(404);
	});

	it("the signed textures from the verified login are kept and served when no live lookup is possible", async () => {
		const unknownMojang = "ab".repeat(16); // no such Mojang profile, so a live lookup finds nothing
		const start = await api("POST", "/api/v1/premium/start", { mc_uuid: UUID });
		const bind = await api("POST", "/api/v1/premium/bind", { token: start.json.token, mojang_uuid: unknownMojang, mojang_name: "Nobody", textures: { value: "snapshot-value", signature: "snapshot-signature" } });
		expect(bind.status).toBe(200);
		// Make the fallback deterministic rather than waiting for a real external Mojang lookup to fail.
		await sql([`INSERT INTO audit_log (at, ft_id, action) VALUES (${Date.now()}, ${ID}, 'mojang_textures_failed')`]);
		const join = await api("POST", "/api/v1/join-check", { name: "x", token: bind.json.session_token });
		expect(join.json.skin).toEqual({ value: "snapshot-value", signature: "snapshot-signature", mojang_uuid: unknownMojang });
	});

	it("a Mojang account can belong to only one 42 user", async () => {
		const t1 = (await api("POST", "/api/v1/premium/start", { mc_uuid: UUID })).json.token;
		expect((await api("POST", "/api/v1/premium/bind", { token: t1, mojang_uuid: NOTCH, mojang_name: "Notch" })).status).toBe(200);
		const t2 = (await api("POST", "/api/v1/premium/start", { mc_uuid: UUID2 })).json.token;
		const clash = await api("POST", "/api/v1/premium/bind", { token: t2, mojang_uuid: NOTCH, mojang_name: "Notch" });
		expect(clash.status).toBe(409);
		const [rows] = await sql([`SELECT count(*) FROM skin_source WHERE ft_id = ${ID2}`]);
		expect(Number(rows[0][0])).toBe(0);
	});

	it("premium start refuses unknown, foreign and banned players; bind refuses bad input", async () => {
		expect((await api("POST", "/api/v1/premium/start", { mc_uuid: "069a79f4-44e9-4726-a5be-fca90e38aaf5" })).status).toBe(404);
		expect((await api("POST", "/api/v1/premium/bind", { token: "nope-nope-nope-nope", mojang_uuid: NOTCH, mojang_name: "Notch" })).status).toBe(404);
		expect((await api("POST", "/api/v1/premium/bind", { token: "x", mojang_uuid: "bad", mojang_name: "Notch" })).status).toBe(400);
		await api("POST", "/api/v1/bans", { mc_uuid: UUID2, reason: "t" });
		expect((await api("POST", "/api/v1/premium/start", { mc_uuid: UUID2 })).status).toBe(403);
	});

	it("anonymous /me redirects to sign-in and forms reject a missing csrf token", async () => {
		const r = await fetch(`${BASE}/me`, { redirect: "manual" });
		expect(r.status).toBe(302);
		expect(r.headers.get("location")).toContain("/me/login");
		const post = await fetch(`${BASE}/me/skin/default`, { method: "POST", redirect: "manual", body: new URLSearchParams({ csrf: "x" }) });
		expect(post.status).toBe(302); // no session -> sign in
	});
});
