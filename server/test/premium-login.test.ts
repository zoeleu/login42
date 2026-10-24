// Real schema, SQL and database adapter (bun:sqlite), with only the external 42 API mocked. No network needed.
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import app from "../src/index";
import { openDb } from "../src/lib/db";
import { migrate } from "../src/lib/migrate";
import { hmacHex, signingString } from "../src/lib/hmac";
import { ftIdToUuid } from "../src/lib/uuid";
import { sha256Hex } from "../src/lib/token";
import { ERASURE_DELAY_MS, GENESIS, recordLogin, redactionStatements, verifyChain } from "../src/lib/audit";

const ID = 7000011;
const MOJANG = "ab".repeat(16);
// Direct SQL access for arranging and inspecting state; rows are loosely typed on purpose.
type Raw = { prepare(sql: string): { get(...p: unknown[]): any; all(...p: unknown[]): any[]; run(...p: unknown[]): unknown }; exec(sql: string): void; close(): void };
let sqlite: Raw;
const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof mock>;
let profile: Record<string, unknown>;
let unavailable: boolean;
let duringLookup: () => void;
let env: Env;

beforeEach(() => {
	const db = openDb(":memory:");
	migrate(db);
	sqlite = db.sqlite as unknown as Raw;
	sqlite.prepare("INSERT INTO users (ft_id, login, uuid, mc_name, created_at) VALUES (?, 'old-name', ?, 'old_name', 1)").run(ID, ftIdToUuid(ID));
	sqlite.prepare("INSERT INTO premium_accounts (ft_id, mojang_uuid, verified_at) VALUES (?, ?, 1)").run(ID, MOJANG);
	env = { DB: db, PUBLIC_URL: "https://test", PLUGIN_HMAC_SECRET: "test-secret", FT_CLIENT_ID: "test-app", FT_CLIENT_SECRET: "test-app-secret", TOKEN_TTL_SECONDS: "120", ALLOW_STAFF: "false", LIMBO_PER_MINUTE: "12", PRIVACY_CONTACT: "privacy@example.test" } as unknown as Env;
	profile = { id: ID, login: "new-name", kind: "student", "active?": true, "alumni?": false, "staff?": false, titles: [{ id: 1328, name: "%login, Writer's soul" }], titles_users: [{ title_id: 1328, selected: true }] };
	unavailable = false;
	duringLookup = () => {};
	fetchMock = mock(async (url: string) => {
		if (url.endsWith("/oauth/token")) return Response.json({ access_token: "app-token", expires_in: 7200 });
		if (url === "https://api.intra.42.fr/v2/me") return Response.json(profile);
		if (url === `https://api.intra.42.fr/v2/users/${ID}`) {
			if (unavailable) return new Response("unavailable", { status: 503 });
			duringLookup();
			return Response.json(profile);
		}
		throw new Error("Unexpected external request: " + url);
	});
	globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => { globalThis.fetch = realFetch; sqlite.close(); });

async function login(uuid = MOJANG, signed = true) {
	const path = "/api/v1/premium/login";
	const body = JSON.stringify({ mojang_uuid: uuid });
	const ts = String(Date.now());
	const signature = signed ? await hmacHex(env.PLUGIN_HMAC_SECRET, signingString(ts, "POST", path, body)) : "0".repeat(64);
	return app.request(`https://test${path}`, { method: "POST", headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": signature }, body }, env);
}

describe("returning Mojang-verified login", () => {
	it("reuses the 42 identity, refreshes login/title, and mints a fresh hashed handoff token", async () => {
		const r = await login();
		expect(r.status).toBe(200);
		const j = await r.json() as { login: string; session_token: string };
		expect(j.login).toBe("new-name");
		expect(j.session_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(sqlite.prepare("SELECT uuid, mc_name, special_title FROM users WHERE ft_id = ?").get(ID)).toMatchObject({ uuid: ftIdToUuid(ID), mc_name: "new_name", special_title: "new-name, Writer's soul" });
		expect(sqlite.prepare("SELECT token_hash FROM tokens WHERE ft_id = ?").get(ID)?.token_hash).toBe(await sha256Hex(j.session_token));
		expect(sqlite.prepare("SELECT action FROM audit_log WHERE ft_id = ?").get(ID)?.action).toBe("premium_login");
	});

	it("requires the plugin HMAC and a previously verified Mojang link", async () => {
		expect((await login(MOJANG, false)).status).toBe(401);
		expect((await login("cd".repeat(16))).status).toBe(404);
		expect((await login("bad uuid")).status).toBe(400);
		sqlite.prepare("DELETE FROM premium_accounts").run();
		expect((await login()).status).toBe(404);
		expect(sqlite.prepare("SELECT count(*) AS n FROM tokens").get()?.n).toBe(0);
	});

	it("denies banned users without issuing a session", async () => {
		sqlite.prepare("INSERT INTO bans (ft_id, created_at) VALUES (?, 1)").run(ID);
		expect((await login()).status).toBe(403);
		expect(sqlite.prepare("SELECT count(*) AS n FROM tokens").get()?.n).toBe(0);
	});

	it("rechecks eligibility and fails closed if 42 is unavailable", async () => {
		profile["active?"] = false;
		expect((await login()).status).toBe(403);
		profile["active?"] = true;
		unavailable = true;
		expect((await login()).status).toBe(502);
		expect(sqlite.prepare("SELECT count(*) AS n FROM tokens").get()?.n).toBe(0);
	});

	it("clears a title that is no longer selected", async () => {
		sqlite.prepare("UPDATE users SET special_title = 'Old title'").run();
		profile.titles_users = [];
		expect((await login()).status).toBe(200);
		expect(sqlite.prepare("SELECT special_title FROM users").get()?.special_title).toBeNull();
	});

	it("keeps login ownership separate from uploaded skins and refuses an unlinked account", async () => {
		sqlite.prepare("INSERT INTO skin_source (ft_id, kind, value, signature, updated_at) VALUES (?, 'upload', 'skin', 'signature', 1)").run(ID);
		expect((await login()).status).toBe(200);
		sqlite.prepare("DELETE FROM premium_accounts WHERE ft_id = ?").run(ID);
		expect((await login()).status).toBe(404);
	});

	it("issues no token if the premium link is revoked during the 42 lookup", async () => {
		duringLookup = () => { sqlite.prepare("DELETE FROM premium_accounts WHERE ft_id = ?").run(ID); };
		expect((await login()).status).toBe(403);
		expect(sqlite.prepare("SELECT count(*) AS n FROM tokens").get()?.n).toBe(0);
	});

	it("issues no token if the account is banned during the 42 lookup", async () => {
		duringLookup = () => { sqlite.prepare("INSERT INTO bans (ft_id, created_at) VALUES (?, 1)").run(ID); };
		expect((await login()).status).toBe(403);
		expect(sqlite.prepare("SELECT count(*) AS n FROM tokens").get()?.n).toBe(0);
	});

	it("the authenticated unlink action revokes both token types and preserves an uploaded skin", async () => {
		const sid = "browser-session";
		sqlite.prepare("INSERT INTO web_sessions VALUES (?, ?, ?)").run(await sha256Hex(sid), ID, Date.now() + 60_000);
		sqlite.prepare("INSERT INTO tokens (token_hash, ft_id, expires_at) VALUES ('handoff', ?, ?)").run(ID, Date.now() + 60_000);
		sqlite.prepare("INSERT INTO premium_tokens (token_hash, ft_id, expires_at) VALUES ('pending-link', ?, ?)").run(ID, Date.now() + 60_000);
		sqlite.prepare("INSERT INTO skin_source (ft_id, kind, value, signature, updated_at) VALUES (?, 'upload', 'skin', 'signature', 1)").run(ID);
		const csrf = await hmacHex(env.PLUGIN_HMAC_SECRET, `csrf:${sid}`);
		const r = await app.request("https://test/me/premium/unlink", { method: "POST", headers: { cookie: `login42_sid=${sid}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf }) }, env);
		expect(r.status).toBe(200);
		for (const table of ["premium_accounts", "tokens", "premium_tokens"]) expect(sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(0);
		expect(sqlite.prepare("SELECT kind FROM skin_source").get()?.kind).toBe("upload");
	});

	it("shares routing hints only with an authenticated game plugin", async () => {
		const path = "/api/v1/premium/accounts";
		expect((await app.request(`https://test${path}`, {}, env)).status).toBe(401);
		const ts = String(Date.now());
		const signature = await hmacHex(env.PLUGIN_HMAC_SECRET, signingString(ts, "GET", path, ""));
		const r = await app.request(`https://test${path}`, { headers: { "x-timestamp": ts, "x-signature": signature } }, env);
		expect(await r.json()).toEqual({ accounts: [MOJANG] });
	});
});

describe("resumable 42 browser sign-in", () => {
	it("accepts a fresh callback once and explains repeats without replaying 42 credentials", async () => {
		sqlite.prepare("INSERT INTO limbo_codes (code, expires_at) VALUES ('FRESH', ?)").run(Date.now() + 60_000);
		sqlite.prepare("INSERT INTO oauth_states (state, link_code, expires_at) VALUES ('test-state', 'FRESH', ?)").run(Date.now() + 60_000);
		const url = "https://test/auth/callback?code=test-code&state=test-state";
		const first = await app.request(url, {}, env);
		expect(first.status).toBe(200);
		expect(await first.text()).toContain("Signed in");
		const second = await app.request(url, {}, env);
		expect(second.status).toBe(400);
		expect(await second.text()).toContain("expired or already used");
		expect(second.headers.get("cache-control")).toBe("no-store");
		expect(sqlite.prepare("SELECT count(*) AS n FROM tokens").get()?.n).toBe(1);
		expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/oauth/token"))).toHaveLength(1);
	});

	it("rejects expired state without exchanging the authorization code", async () => {
		sqlite.prepare("INSERT INTO oauth_states (state, link_code, expires_at) VALUES ('expired-state', 'web', ?)").run(Date.now() - 1);
		expect((await app.request("https://test/auth/callback?code=test-code&state=expired-state", {}, env)).status).toBe(400);
		expect(fetch).not.toHaveBeenCalled();
	});
	it("keeps the Minecraft link open and creates a fresh full OAuth request for each retry", async () => {
		const code = "TESTCODE42";
		sqlite.prepare("INSERT INTO limbo_codes (code, expires_at) VALUES (?, ?)").run(code, Date.now() + 60_000);
		const landing = await app.request(`https://test/link/${code}`, {}, env);
		expect(landing.status).toBe(200);
		expect(landing.headers.get("cache-control")).toBe("no-store");
		expect(await landing.text()).toContain(`href="/link/${code}/authorize" target="_blank" rel="noopener"`);
		expect(sqlite.prepare("SELECT count(*) AS n FROM oauth_states").get()?.n).toBe(0);
		const states = new Set<string>();
		for (let i = 0; i < 2; i++) {
			const r = await app.request(`https://test/link/${code}/authorize`, {}, env);
			expect(r.status).toBe(302);
			const url = new URL(r.headers.get("location")!);
			expect(url.origin + url.pathname).toBe("https://api.intra.42.fr/oauth/authorize");
			expect(url.searchParams.get("response_type")).toBe("code");
			expect(url.searchParams.get("client_id")).toBe("test-app");
			expect(url.searchParams.get("redirect_uri")).toBe("https://test/auth/callback");
			states.add(url.searchParams.get("state")!);
		}
		expect(states.size).toBe(2);
		expect(sqlite.prepare("SELECT count(*) AS n FROM oauth_states WHERE link_code = ?").get(code)?.n).toBe(2);
	});

	it("does not restart expired or already claimed Minecraft links", async () => {
		sqlite.prepare("INSERT INTO limbo_codes (code, expires_at, ft_id) VALUES ('EXPIRED', ?, NULL), ('CLAIMED', ?, ?)").run(Date.now() - 1, Date.now() + 60_000, ID);
		for (const code of ["EXPIRED", "CLAIMED", "MISSING"]) {
			expect((await app.request(`https://test/link/${code}`, {}, env)).status).toBe(410);
			expect((await app.request(`https://test/link/${code}/authorize`, {}, env)).status).toBe(410);
		}
		expect(sqlite.prepare("SELECT count(*) AS n FROM oauth_states").get()?.n).toBe(0);
	});

	it("also provides a retryable sign-in entry for the web profile", async () => {
		const page = await app.request("https://test/me/login", {}, env);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain('href="/me/authorize" target="_blank"');
		const r = await app.request("https://test/me/authorize", {}, env);
		expect(r.status).toBe(302);
		const url = new URL(r.headers.get("location")!);
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(sqlite.prepare("SELECT link_code FROM oauth_states WHERE state = ?").get(url.searchParams.get("state")!)?.link_code).toBe("web");
	});
});

describe("online skin selection API", () => {
	async function skins(uuids: unknown, signed = true) {
		const path = "/api/v1/skins";
		const body = JSON.stringify({ uuids });
		const ts = String(Date.now());
		const signature = signed ? await hmacHex(env.PLUGIN_HMAC_SECRET, signingString(ts, "POST", path, body)) : "0".repeat(64);
		return app.request(`https://test${path}`, { method: "POST", headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": signature }, body }, env);
	}

	it("requires plugin authentication and bounded canonical UUID requests", async () => {
		expect((await skins([ftIdToUuid(ID)], false)).status).toBe(401);
		for (const invalid of [null, "not-an-array", ["random-uuid"], Array(101).fill(ftIdToUuid(ID))]) expect((await skins(invalid)).status).toBe(400);
		expect(await (await skins([])).json()).toEqual({ skins: [] });
	});

	it("returns current upload, default reset, and Mojang selection without external lookups", async () => {
		const uuid = ftIdToUuid(ID);
		sqlite.prepare("INSERT INTO skin_source (ft_id, kind, value, signature, updated_at) VALUES (?, 'upload', 'skin-value', 'signed', 1)").run(ID);
		expect(await (await skins([uuid, uuid])).json()).toEqual({ skins: [{ uuid, kind: "upload", mojang_uuid: null, value: "skin-value", signature: "signed" }] });
		sqlite.prepare("DELETE FROM skin_source WHERE ft_id = ?").run(ID);
		expect(await (await skins([uuid])).json()).toEqual({ skins: [{ uuid, kind: "default", mojang_uuid: null, value: null, signature: null }] });
		sqlite.prepare("INSERT INTO skin_source (ft_id, kind, mojang_uuid, value, signature, updated_at) VALUES (?, 'mojang', ?, 'fallback', 'signed', 1)").run(ID, MOJANG);
		expect(await (await skins([uuid])).json()).toMatchObject({ skins: [{ uuid, kind: "mojang", mojang_uuid: MOJANG }] });
		expect(await (await skins([ftIdToUuid(ID + 1)])).json()).toEqual({ skins: [] });
		expect(fetch).not.toHaveBeenCalled();
		expect(sqlite.prepare("SELECT count(*) AS n FROM premium_accounts").get()?.n).toBe(1);
	});
});

describe("login audit", () => {
	async function plugin(path: string, payload: unknown) {
		const body = JSON.stringify(payload);
		const ts = String(Date.now());
		const signature = await hmacHex(env.PLUGIN_HMAC_SECRET, signingString(ts, "POST", path, body));
		return app.request(`https://test${path}`, { method: "POST", headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": signature }, body }, env);
	}
	const audit = () => sqlite.prepare("SELECT * FROM login_audit ORDER BY id").all() as Record<string, any>[];
	const join = (token: string, ip = "203.0.113.7") => plugin("/api/v1/join-check", { name: "SomeClaim", token, ip, client_uuid: "00000000-0000-3000-8000-000000000001", host: "42.g.example:24242" });

	it("traces a premium login from Mojang proof to game entry by token hash, never storing the token", async () => {
		const issued = await plugin("/api/v1/premium/login", { mojang_uuid: MOJANG, mojang_name: "Premium", ip: "198.51.100.4", host: "42craft.example" });
		const token = ((await issued.json()) as { session_token: string }).session_token;
		const entered = await join(token);
		expect(entered.status).toBe(200);
		const j = await entered.json() as { status: string; audit_id: number; audit_hash: string };
		expect(j.status).toBe("allow");
		const [login, game] = audit();
		expect(login).toMatchObject({ event: "premium_login", ft_id: ID, login: "new-name", mc_name: "new_name", mojang_uuid: MOJANG, mojang_name: "Premium", ip: "198.51.100.4", ip_source: "game", token_hash: await sha256Hex(token) });
		expect(game).toMatchObject({ id: j.audit_id, hash: j.audit_hash, event: "game_login", ft_id: ID, login: "new-name", mc_name: "new_name", mc_uuid: ftIdToUuid(ID), ip: "203.0.113.7", client_name: "SomeClaim", client_uuid: "00000000-0000-3000-8000-000000000001", host: "42.g.example:24242", token_hash: login.token_hash, prev_hash: login.hash });
		expect(JSON.stringify(audit())).not.toContain(token);
	});

	it("records replay of a spent token with the replaying address", async () => {
		sqlite.prepare("INSERT INTO tokens (token_hash, ft_id, expires_at) VALUES (?, ?, ?)").run(await sha256Hex("handoff-token"), ID, Date.now() + 60_000);
		expect(((await (await join("handoff-token")).json()) as { status: string }).status).toBe("allow");
		expect(((await (await join("handoff-token", "203.0.113.99")).json()) as { status: string }).status).toBe("limbo");
		expect(audit().map(r => [r.event, r.ip])).toEqual([["game_login", "203.0.113.7"], ["token_reuse", "203.0.113.99"]]);
	});

	it("records browser sign-ins with the proxy-verified client address and the token issued", async () => {
		sqlite.prepare("INSERT INTO limbo_codes (code, expires_at) VALUES ('FRESH', ?)").run(Date.now() + 60_000);
		sqlite.prepare("INSERT INTO oauth_states (state, link_code, expires_at) VALUES ('s1', 'FRESH', ?)").run(Date.now() + 60_000);
		const r = await app.request("https://test/auth/callback?code=c&state=s1", { headers: { "x-forwarded-for": "2001:db8::5", "user-agent": "Browser/1.0" } }, env);
		expect(r.status).toBe(200);
		const token = sqlite.prepare("SELECT token_hash FROM tokens").get()?.token_hash;
		expect(audit()).toEqual([expect.objectContaining({ event: "oauth_game", ft_id: ID, ip: "2001:db8::5", ip_source: "browser", user_agent: "Browser/1.0", token_hash: token })]);
	});

	it("ignores a forgeable CF-Connecting-IP and unparseable forwarded lists", async () => {
		for (const [state, headers] of [["s1", { "cf-connecting-ip": "198.51.100.9" }], ["s2", { "x-forwarded-for": "198.51.100.9, 10.0.0.1" }]] as const) {
			sqlite.prepare("INSERT INTO oauth_states (state, link_code, expires_at) VALUES (?, 'web', ?)").run(state, Date.now() + 60_000);
			expect((await app.request(`https://test/auth/callback?code=c&state=${state}`, { headers }, env)).status).toBe(302);
		}
		expect(audit().map(r => [r.event, r.ip])).toEqual([["oauth_web", null], ["oauth_web", null]]);
	});

	it("fails closed: without an audit record no one enters and no premium credential survives", async () => {
		sqlite.prepare("INSERT INTO tokens (token_hash, ft_id, expires_at) VALUES (?, ?, ?)").run(await sha256Hex("handoff-token"), ID, Date.now() + 60_000);
		sqlite.exec("DROP TABLE login_audit");
		expect((await join("handoff-token")).status).toBe(503);
		expect((await plugin("/api/v1/premium/login", { mojang_uuid: MOJANG })).status).toBe(503);
		expect(sqlite.prepare("SELECT count(*) AS n FROM tokens WHERE used_at IS NULL").get()?.n).toBe(0);
	});

	it("is append-only and its hash chain detects edits, deletions and a forged start", async () => {
		for (const ip of ["192.0.2.1", "192.0.2.2", "192.0.2.3"]) await recordLogin(env.DB, { event: "game_login", ft_id: ID, ip, ip_source: "game" });
		const good = await verifyChain(env.DB);
		expect(good).toMatchObject({ ok: true, rows: 3, first: { prev_hash: GENESIS }, head: { id: 3 } });
		expect(() => sqlite.exec("UPDATE login_audit SET ip = '10.0.0.1' WHERE id = 2")).toThrow(/append-only/);
		expect(() => sqlite.exec("UPDATE login_audit SET ip = NULL, redacted_at = 1 WHERE id = 2")).toThrow(/append-only/); // partial redaction
		expect(() => sqlite.exec("DELETE FROM login_audit WHERE id = 2")).toThrow(/append-only/);

		sqlite.exec("DROP TRIGGER login_audit_redact_only; DROP TRIGGER login_audit_no_delete");
		sqlite.exec("UPDATE login_audit SET ip = '10.0.0.1' WHERE id = 2");
		expect(await verifyChain(env.DB)).toMatchObject({ ok: false, error: { id: 2, reason: "row content does not match its hash" } });
		sqlite.exec("UPDATE login_audit SET ip = '192.0.2.2' WHERE id = 2");
		sqlite.exec("DELETE FROM login_audit WHERE id = 2");
		expect(await verifyChain(env.DB)).toMatchObject({ ok: false, error: { id: 3 } });
		sqlite.exec("DELETE FROM login_audit WHERE id = 1");
		expect(await verifyChain(env.DB)).toMatchObject({ ok: false, error: { reason: "chain does not start at genesis" } });
	});

	it("keeps the chain linear when writers race", async () => {
		await Promise.all(Array.from({ length: 6 }, (_, i) => recordLogin(env.DB, { event: "game_login", ft_id: ID, ip: `192.0.2.${i}` })));
		expect(await verifyChain(env.DB)).toMatchObject({ ok: true, rows: 6 });
	});
});

describe("account deletion and record retention", () => {
	const sid = "browser-session";
	async function deleteSelf(confirm = "yes") {
		sqlite.prepare("INSERT OR IGNORE INTO web_sessions VALUES (?, ?, ?)").run(await sha256Hex(sid), ID, Date.now() + 60_000);
		const csrf = await hmacHex(env.PLUGIN_HMAC_SECRET, `csrf:${sid}`);
		return app.request("https://test/me/delete", { method: "POST", headers: { cookie: `login42_sid=${sid}`, "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "192.0.2.50" }, body: new URLSearchParams({ csrf, confirm }) }, env);
	}

	it("deletes and anonymizes the account but schedules login records for redaction 6 months later", async () => {
		sqlite.prepare("INSERT INTO skin_source (ft_id, kind, value, signature, updated_at) VALUES (?, 'upload', 'skin', 'signature', 1)").run(ID);
		sqlite.prepare("INSERT INTO audit_log (at, ft_id, action, detail) VALUES (1, ?, 'premium_link', ?)").run(ID, MOJANG);
		await recordLogin(env.DB, { event: "game_login", ft_id: ID, login: "old-name", mc_name: "old_name", ip: "192.0.2.10" });
		await recordLogin(env.DB, { event: "premium_proof", mojang_uuid: MOJANG, ip: "192.0.2.11" });
		await recordLogin(env.DB, { event: "game_login", ft_id: 99, ip: "192.0.2.12" }); // someone else

		expect((await deleteSelf("no")).status).toBe(200);
		expect(sqlite.prepare("SELECT count(*) AS n FROM users").get()?.n).toBe(1);
		const r = await deleteSelf();
		expect(await r.text()).toContain("Account deleted");
		for (const table of ["users", "premium_accounts", "skin_source", "web_sessions", "tokens"]) expect(sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(0);
		expect(sqlite.prepare("SELECT count(*) AS n FROM audit_log WHERE ft_id IS NOT NULL OR detail = ?").get(MOJANG)?.n).toBe(0);
		const erasure = sqlite.prepare("SELECT * FROM login_audit_erasure").get() as Record<string, number>;
		expect(erasure).toMatchObject({ ft_id: ID, mojang_uuid: MOJANG });
		expect(erasure.erase_after - erasure.requested_at).toBe(ERASURE_DELAY_MS);
		expect(sqlite.prepare("SELECT event, ip, mc_name FROM login_audit WHERE event = 'account_deleted'").get()).toMatchObject({ ip: "192.0.2.50", mc_name: "old_name" });

		// Not due yet: nothing is redacted.
		await env.DB.batch(redactionStatements(env.DB));
		expect(sqlite.prepare("SELECT count(*) AS n FROM login_audit WHERE redacted_at IS NOT NULL").get()?.n).toBe(0);
		// A later sign-in after deletion is a new account; its records are not covered by the old request.
		await recordLogin(env.DB, { event: "game_login", ft_id: ID, ip: "192.0.2.13" });

		await env.DB.batch(redactionStatements(env.DB, erasure.erase_after));
		const rows = sqlite.prepare("SELECT ip, ft_id, mc_name, redacted_at FROM login_audit ORDER BY id").all() as Record<string, unknown>[];
		expect(rows.map(r => r.ip)).toEqual([null, null, "192.0.2.12", null, "192.0.2.13"]);
		expect(rows.filter(r => r.redacted_at).every(r => r.ft_id === null && r.mc_name === null)).toBe(true);
		expect(sqlite.prepare("SELECT count(*) AS n FROM login_audit_erasure").get()?.n).toBe(0);
		expect(await verifyChain(env.DB)).toMatchObject({ ok: true, rows: 5, redacted: 3 });
	});

	it("refuses to delete a banned account, keeping the ban enforceable", async () => {
		sqlite.prepare("INSERT INTO bans (ft_id, created_at) VALUES (?, 1)").run(ID);
		expect(await (await deleteSelf()).text()).toContain("cannot be deleted");
		expect(sqlite.prepare("SELECT count(*) AS n FROM users").get()?.n).toBe(1);
		expect(sqlite.prepare("SELECT count(*) AS n FROM login_audit_erasure").get()?.n).toBe(0);
	});
});

describe("public pages", () => {
	it("serves the index and both privacy policy languages, linked from every page", async () => {
		const index = await (await app.request("https://test/", {}, env)).text();
		for (const link of ['href="/me"', 'href="/privacy"', 'href="/privacidade"']) expect(index).toContain(link);
		const pt = await (await app.request("https://test/privacidade", {}, env)).text();
		expect(pt).toContain('lang="pt-BR"');
		expect(pt).toContain("legítimo interesse");
		expect(pt).toContain("privacy@example.test");
		const en = await (await app.request("https://test/privacy", {}, env)).text();
		expect(en).toContain("legitimate interest");
		expect(await (await app.request("https://test/me/login", {}, env)).text()).toContain('href="/privacidade"');
	});
});
