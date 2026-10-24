import { Hono, type Context } from "hono";
import { admin } from "./admin";
import { me as meApp } from "./me";
import { pages } from "./pages";
import { mojangTextures } from "./lib/mojang";
import { linkPremium } from "./lib/premium";
import { signInPage, startWebSession } from "./lib/web";
import { banUser, pardonUser } from "./lib/bans";
import { browserContext, cleanIp, cleanText, recordLogin, recordLoginBestEffort, redactionStatements } from "./lib/audit";
import { allow, ipKey } from "./lib/rate";
import { authorizeUrl, exchangeCode, fetchMe, fetchUserById, isEligible, selectedTitle } from "./lib/ft42";
import { hmacVerify, MAX_SKEW_MS, signingString } from "./lib/hmac";
import { newSessionToken, sha256Hex } from "./lib/token";
import { escapeHtml, linkCode, mcNameFromLogin, MC_NAME_RE, nowMs, page, randomToken } from "./lib/util";
import { ftIdToUuid, uuidToFtId } from "./lib/uuid";

const LINK_TTL_MS = 10 * 60_000;
const USED_TOKEN_RETENTION_MS = 24 * 3_600_000;

interface UserRow {
	ft_id: number;
	login: string;
	uuid: string;
	mc_name: string;
}

const app = new Hono<{ Bindings: Env }>();
app.route("/admin/v1", admin);
app.route("/me", meApp);
app.route("/", pages);

const tokenTtlMs = (env: Env) => Number(env.TOKEN_TTL_SECONDS) * 1000;

// --- plugin -> server: HMAC(timestamp.method.path.body), 30s skew window ---
app.use("/api/v1/*", async (c, next) => {
	const ts = c.req.header("x-timestamp") ?? "";
	const sig = c.req.header("x-signature") ?? "";
	if (!/^\d{13}$/.test(ts) || Math.abs(nowMs() - Number(ts)) > MAX_SKEW_MS) {
		return c.json({ error: "stale or missing timestamp" }, 401);
	}
	const body = await c.req.text();
	const msg = signingString(ts, c.req.method, new URL(c.req.url).pathname, body);
	if (!(await hmacVerify(c.env.PLUGIN_HMAC_SECRET, msg, sig))) return c.json({ error: "bad signature" }, 401);
	await next();
});

async function jsonBody<T>(c: Context): Promise<T | null> {
	try {
		return (await c.req.json()) as T;
	} catch {
		return null;
	}
}

// Issues a single-use handoff token for a user (cookie value the limbo guest stores before transferring).
async function mintToken(env: Env, ftId: number) {
	const token = newSessionToken();
	const stmt = env.DB.prepare("INSERT INTO tokens (token_hash, ft_id, expires_at) VALUES (?, ?, ?)").bind(await sha256Hex(token), ftId, nowMs() + tokenTtlMs(env));
	return { token, stmt };
}

// Signed textures to apply at join, or null for the client-chosen default skin.
async function skinFor(env: Env, ftId: number): Promise<{ value: string; signature: string; mojang_uuid?: string } | null> {
	const s = await env.DB.prepare("SELECT kind, mojang_uuid, value, signature FROM skin_source WHERE ft_id = ?").bind(ftId).first<{ kind: string; mojang_uuid: string | null; value: string | null; signature: string | null }>();
	if (!s) return null;
	if (s.kind === "upload" && s.value && s.signature) return { value: s.value, signature: s.signature };
	if (s.kind === "mojang" && s.mojang_uuid) {
		// Mojang answers 403 to Cloudflare's shared egress addresses, so the live lookup often cannot work. After a failure,
		// skip further live attempts for an hour (no wasted latency or audit spam) and serve the stored snapshot.
		const recentFailure = await env.DB.prepare("SELECT 1 FROM audit_log WHERE ft_id = ? AND action = 'mojang_textures_failed' AND at > ?").bind(ftId, nowMs() - 3_600_000).first();
		if (!recentFailure) {
			try {
				const fresh = await mojangTextures(env.DB, s.mojang_uuid);
				if (fresh) return { ...fresh, mojang_uuid: s.mojang_uuid };
			} catch (e) {
				await env.DB.prepare("INSERT INTO audit_log (at, ft_id, action, detail) VALUES (?, ?, 'mojang_textures_failed', ?)").bind(nowMs(), ftId, String(e).slice(0, 200)).run();
			}
		}
		// Fall back to the signed snapshot saved when the account was verified.
		return s.value && s.signature ? { value: s.value, signature: s.signature, mojang_uuid: s.mojang_uuid } : null;
	}
	return null;
}

// Join gate. `token` is the cookie the client presented (or null). A valid token is consumed and logs
// the player in as their 42 identity; anything else sends them to limbo to sign in.
app.post("/api/v1/join-check", async (c) => {
	const b = await jsonBody<{ name?: string; token?: string | null; ip?: string; client_uuid?: string; host?: string }>(c);
	if (!b?.name || !MC_NAME_RE.test(b.name)) return c.json({ error: "bad request" }, 400);
	const db = c.env.DB;

	if (b.token) {
		const hash = await sha256Hex(b.token);
		const row = await db
			.prepare("SELECT t.expires_at, t.used_at, u.ft_id, u.login, u.uuid, u.mc_name, u.special_title FROM tokens t JOIN users u USING (ft_id) WHERE t.token_hash = ?")
			.bind(hash)
			.first<{ expires_at: number; used_at: number | null; ft_id: number; login: string; uuid: string; mc_name: string; special_title: string | null }>();
		// The connection as the game server saw it. The client name/UUID are claims, recorded but never trusted.
		const seen = (event: "game_login" | "game_login_banned" | "token_reuse") => ({
			event, ft_id: row!.ft_id, login: row!.login, mc_uuid: row!.uuid, mc_name: row!.mc_name, ip: cleanIp(b.ip), ip_source: "game" as const,
			client_name: b.name, client_uuid: cleanText(b.client_uuid, 36), token_hash: hash, host: cleanText(b.host, 255),
		});
		if (row?.used_at) {
			// An already-rotated token came back: someone has a copy. Revoke every session of that user.
			await db.batch([
				db.prepare("DELETE FROM tokens WHERE ft_id = ?").bind(row.ft_id),
				db.prepare("INSERT INTO audit_log (at, ft_id, action, detail) VALUES (?, ?, 'token_reuse', NULL)").bind(nowMs(), row.ft_id),
			]);
			await recordLoginBestEffort(db, seen("token_reuse"));
		} else if (row && row.expires_at > nowMs()) {
			const ban = await db.prepare("SELECT reason FROM bans WHERE ft_id = ?").bind(row.ft_id).first<{ reason: string | null }>();
			if (ban) {
				await recordLoginBestEffort(db, seen("game_login_banned"));
				return c.json({ status: "banned", reason: ban.reason });
			}
			// Exactly one connection may consume a token; a concurrent loser falls through to limbo.
			const consumed = await db.prepare("UPDATE tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL").bind(nowMs(), hash).run();
			if (consumed.meta.changes === 1) {
				await db.prepare("DELETE FROM tokens WHERE used_at < ?").bind(nowMs() - USED_TOKEN_RETENTION_MS).run();
				// No audit record, no entry: the token is already spent, so the player signs in again.
				let audit;
				try {
					audit = await recordLogin(db, seen("game_login"));
				} catch (e) {
					console.error("join-check: login audit unavailable", String(e));
					return c.json({ error: "audit unavailable" }, 503);
				}
				return c.json({ status: "allow", uuid: row.uuid, name: row.mc_name, special_title: row.special_title, skin: await skinFor(c.env, row.ft_id), audit_id: audit.id, audit_hash: audit.hash });
			}
		}
	}

	// Only the unauthenticated path creates rows: cap it per source address and globally.
	const perMinute = Number(c.env.LIMBO_PER_MINUTE);
	if (b.ip && !(await allow(db, `ip:${await ipKey(c.env.PLUGIN_HMAC_SECRET, b.ip)}`, perMinute))) return c.json({ status: "rate_limited" });
	if (!(await allow(db, "global", perMinute * 20))) return c.json({ status: "rate_limited" });

	const code = linkCode();
	await db.batch([
		// Opportunistic purge of everything that can expire (there is no cron to depend on).
		db.prepare("DELETE FROM limbo_codes WHERE expires_at < ?").bind(nowMs()),
		db.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(nowMs()),
		db.prepare("DELETE FROM web_sessions WHERE expires_at < ?").bind(nowMs()),
		db.prepare("DELETE FROM premium_proofs WHERE expires_at < ?").bind(nowMs()),
		...redactionStatements(db),
		db.prepare("INSERT INTO limbo_codes (code, expires_at) VALUES (?, ?)").bind(code, nowMs() + LINK_TTL_MS),
	]);
	return c.json({ status: "limbo", code, url: `${c.env.PUBLIC_URL}/link/${code}` });
});

// Online skin refresh reads stored selection only. Mojang requests originate on the game server.
app.post("/api/v1/skins", async (c) => {
	const b = await jsonBody<{ uuids?: unknown }>(c);
	if (!Array.isArray(b?.uuids) || b.uuids.length > 100 || b.uuids.some(u => typeof u !== "string" || uuidToFtId(u) === null)) return c.json({ error: "bad request" }, 400);
	const ids = [...new Set((b.uuids as string[]).map(u => uuidToFtId(u)!))];
	if (!ids.length) return c.json({ skins: [] });
	const { results } = await c.env.DB.prepare(`SELECT u.uuid, COALESCE(s.kind, 'default') AS kind, s.mojang_uuid, s.value, s.signature FROM users u LEFT JOIN skin_source s USING (ft_id) WHERE u.ft_id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all();
	return c.json({ skins: results });
});

// Limbo guest polls until the browser sign-in completes; the token is handed over exactly once.
app.get("/api/v1/limbo/:code", async (c) => {
	const db = c.env.DB;
	const code = c.req.param("code");
	const row = await db.prepare("SELECT ft_id, expires_at FROM limbo_codes WHERE code = ?").bind(code).first<{ ft_id: number | null; expires_at: number }>();
	if (!row || row.expires_at < nowMs()) return c.json({ status: "expired" });
	if (row.ft_id === -1) return c.json({ status: "failed" });
	if (!row.ft_id) return c.json({ status: "pending" });
	const cur = await db.prepare("SELECT pending_token FROM limbo_codes WHERE code = ?").bind(code).first<{ pending_token: string | null }>();
	if (!cur?.pending_token) return c.json({ status: "expired" });
	// Claim the one-time handoff; if a concurrent poll won, report expired.
	const claim = await db.prepare("UPDATE limbo_codes SET pending_token = NULL WHERE code = ? AND pending_token = ?").bind(code, cur.pending_token).run();
	return claim.meta.changes === 1 ? c.json({ status: "done", token: cur.pending_token }) : c.json({ status: "expired" });
});

app.post("/api/v1/bans", async (c) => {
	const b = await jsonBody<{ mc_uuid?: string; reason?: string; source?: string }>(c);
	const ftId = b?.mc_uuid ? uuidToFtId(b.mc_uuid) : null;
	if (!ftId) return c.json({ error: "not a 42-linked uuid" }, 404);
	if (!(await c.env.DB.prepare("SELECT 1 FROM users WHERE ft_id = ?").bind(ftId).first())) return c.json({ error: "unknown user" }, 404);
	await banUser(c.env.DB, ftId, b!.reason ?? null, b!.source ?? null);
	return c.json({ ok: true });
});

app.post("/api/v1/pardons", async (c) => {
	const b = await jsonBody<{ mc_uuid?: string; source?: string }>(c);
	const ftId = b?.mc_uuid ? uuidToFtId(b.mc_uuid) : null;
	if (!ftId) return c.json({ error: "not a 42-linked uuid" }, 404);
	await pardonUser(c.env.DB, ftId, b!.source ?? null);
	return c.json({ ok: true });
});

// The verifier calls this after a player proved ownership of a Mojang account through a real online-mode login.
app.post("/api/v1/premium/proof", async (c) => {
	const b = await jsonBody<{ mojang_uuid?: string; mojang_name?: string; ip?: string; host?: string }>(c);
	const id = (b?.mojang_uuid ?? "").replaceAll("-", "").toLowerCase();
	if (!/^[0-9a-f]{32}$/.test(id) || !b?.mojang_name || !/^[A-Za-z0-9_]{1,16}$/.test(b.mojang_name)) return c.json({ error: "bad request" }, 400);
	if (!(await allow(c.env.DB, `proof:${id}`, 5))) return c.json({ error: "rate limited" }, 429);
	const code = linkCode().slice(0, 8);
	await recordLogin(c.env.DB, { event: "premium_proof", mojang_uuid: id, mojang_name: b.mojang_name, ip: cleanIp(b.ip), ip_source: "game", host: cleanText(b.host, 255) });
	await c.env.DB.batch([
		c.env.DB.prepare("DELETE FROM premium_proofs WHERE expires_at < ? OR mojang_uuid = ?").bind(nowMs(), id),
		c.env.DB.prepare("INSERT INTO premium_proofs (code, mojang_uuid, mojang_name, expires_at) VALUES (?, ?, ?, ?)").bind(code, id, b.mojang_name, nowMs() + LINK_TTL_MS),
	]);
	return c.json({ code });
});

// /premium in game: a signed-in player asks to link a Mojang account. Returns a one-time token the plugin stores in
// their client (cookie) before transferring them to the verifier, so no code has to be typed anywhere.
app.post("/api/v1/premium/start", async (c) => {
	const b = await jsonBody<{ mc_uuid?: string }>(c);
	const ftId = b?.mc_uuid ? uuidToFtId(b.mc_uuid) : null;
	if (!ftId) return c.json({ error: "not a 42-linked uuid" }, 404);
	const db = c.env.DB;
	if (!(await db.prepare("SELECT 1 FROM users WHERE ft_id = ?").bind(ftId).first())) return c.json({ error: "unknown user" }, 404);
	if (await db.prepare("SELECT 1 FROM bans WHERE ft_id = ?").bind(ftId).first()) return c.json({ error: "banned" }, 403);
	if (!(await allow(db, `premium-start:${ftId}`, 5))) return c.json({ error: "rate limited" }, 429);
	const token = newSessionToken();
	await db.batch([
		db.prepare("DELETE FROM premium_tokens WHERE expires_at < ? OR ft_id = ?").bind(nowMs(), ftId),
		db.prepare("INSERT INTO premium_tokens (token_hash, ft_id, expires_at) VALUES (?, ?, ?)").bind(await sha256Hex(token), ftId, nowMs() + LINK_TTL_MS),
	]);
	return c.json({ token });
});

// Called only by the HMAC-authenticated game plugin AFTER Mojang hasJoined proves ownership.
// The saved link survives reconnects; the cookie remains a short-lived, single-use transfer token.
app.post("/api/v1/premium/login", async (c) => {
	const b = await jsonBody<{ mojang_uuid?: string; mojang_name?: string; ip?: string; host?: string }>(c);
	const id = (b?.mojang_uuid ?? "").replaceAll("-", "").toLowerCase();
	if (!/^[0-9a-f]{32}$/.test(id)) return c.json({ error: "bad request" }, 400);
	const db = c.env.DB;
	const user = await db.prepare("SELECT u.ft_id, u.login, u.uuid, u.mc_name FROM users u JOIN premium_accounts p USING (ft_id) WHERE p.mojang_uuid = ?").bind(id).first<{ ft_id: number; login: string; uuid: string; mc_name: string }>();
	if (!user) return c.json({ error: "not linked" }, 404);
	const seen = { ft_id: user.ft_id, login: user.login, mc_uuid: user.uuid, mc_name: user.mc_name, mojang_uuid: id, mojang_name: cleanText(b!.mojang_name, 16), ip: cleanIp(b!.ip), ip_source: "game" as const, host: cleanText(b!.host, 255) };
	const deny = async (error: string, status: 403 | 409 | 502) => {
		await recordLoginBestEffort(db, { ...seen, event: "premium_login_denied", detail: error });
		return c.json({ error }, status);
	};
	if (await db.prepare("SELECT 1 FROM bans WHERE ft_id = ?").bind(user.ft_id).first()) return deny("banned", 403);
	if (!(await allow(db, `premium-login:${user.ft_id}`, 12))) return c.json({ error: "rate limited" }, 429);
	let me;
	try {
		me = await fetchUserById(c.env, user.ft_id);
	} catch {
		return deny("42 login service unavailable", 502);
	}
	if (!me || me.id !== user.ft_id || !isEligible(me, String(c.env.ALLOW_STAFF) === "true")) return deny("42 account is no longer eligible", 403);
	const name = mcNameFromLogin(me.login);
	if (!name) return deny("unsupported 42 login", 409);
	try {
		await db.prepare("UPDATE users SET login = ?, mc_name = ?, special_title = ? WHERE ft_id = ?").bind(me.login, name, selectedTitle(me), me.id).run();
	} catch {
		return deny("42 name conflict", 409);
	}
	// Issue the token atomically only while this ownership link still exists and the account is not banned.
	// An unlink or ban during the external 42 lookup must not result in a fresh login credential.
	const token = newSessionToken();
	const tokenHash = await sha256Hex(token);
	const issued = await db.prepare("INSERT INTO tokens (token_hash, ft_id, expires_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM premium_accounts WHERE ft_id = ? AND mojang_uuid = ?) AND NOT EXISTS (SELECT 1 FROM bans WHERE ft_id = ?)")
		.bind(tokenHash, me.id, nowMs() + tokenTtlMs(c.env), me.id, id, me.id).run();
	if (issued.meta.changes !== 1) return deny("account banned or premium link revoked", 403);
	try {
		await recordLogin(db, { ...seen, event: "premium_login", login: me.login, mc_name: name, token_hash: tokenHash });
	} catch (e) {
		// Withdraw the credential rather than admit someone without a record.
		await db.prepare("DELETE FROM tokens WHERE token_hash = ?").bind(tokenHash).run();
		console.error("premium/login: login audit unavailable", String(e));
		return c.json({ error: "audit unavailable" }, 503);
	}
	await db.prepare("INSERT INTO audit_log (at, ft_id, action, detail) VALUES (?, ?, 'premium_login', NULL)").bind(nowMs(), me.id).run();
	return c.json({ ok: true, login: me.login, session_token: token });
});

// A routing hint for the game plugin, never login proof. Every selected connection still performs
// Mojang's online-mode handshake and passes through premium/login's current eligibility/ban checks.
app.get("/api/v1/premium/accounts", async (c) => {
	const { results } = await c.env.DB.prepare("SELECT mojang_uuid FROM premium_accounts").all<{ mojang_uuid: string }>();
	return c.json({ accounts: results.map(r => r.mojang_uuid) });
});

// The verifier reports a Mojang login it verified itself, with the token from the player's cookie.
app.post("/api/v1/premium/bind", async (c) => {
	const b = await jsonBody<{ token?: string; mojang_uuid?: string; mojang_name?: string; textures?: { value?: string; signature?: string }; ip?: string; host?: string }>(c);
	const id = (b?.mojang_uuid ?? "").replaceAll("-", "").toLowerCase();
	if (!b?.token || !/^[0-9a-f]{32}$/.test(id)) return c.json({ error: "bad request" }, 400);
	// Single use: the token is consumed whether or not the link then succeeds.
	const row = await c.env.DB.prepare("DELETE FROM premium_tokens WHERE token_hash = ? AND expires_at > ? RETURNING ft_id").bind(await sha256Hex(b.token), nowMs()).first<{ ft_id: number }>();
	if (!row) return c.json({ error: "invalid or expired token" }, 404);
	const user = await c.env.DB.prepare("SELECT login, uuid, mc_name FROM users WHERE ft_id = ?").bind(row.ft_id).first<{ login: string; uuid: string; mc_name: string }>();
	if (await c.env.DB.prepare("SELECT 1 FROM bans WHERE ft_id = ?").bind(row.ft_id).first()) return c.json({ error: "banned" }, 403);
	const tx = b.textures?.value && b.textures.signature && b.textures.value.length < 8192 && b.textures.signature.length < 2048 ? { value: b.textures.value, signature: b.textures.signature } : null;
	const result = await linkPremium(c.env.DB, row.ft_id, id, tx);
	if (result !== "ok") return c.json({ error: "mojang account already linked to another player" }, 409);
	// A fresh handoff token so the verifier can transfer the player straight back into the game as themselves.
	const session = await mintToken(c.env, row.ft_id);
	try {
		await recordLogin(c.env.DB, {
			event: "premium_link", ft_id: row.ft_id, login: user?.login, mc_uuid: user?.uuid, mc_name: user?.mc_name, mojang_uuid: id, mojang_name: cleanText(b.mojang_name, 16),
			ip: cleanIp(b.ip), ip_source: "game", host: cleanText(b.host, 255), token_hash: await sha256Hex(session.token),
		});
	} catch (e) {
		// The link stands, but no credential is handed out unrecorded: the player reconnects normally.
		console.error("premium/bind: login audit unavailable", String(e));
		return c.json({ error: "audit unavailable" }, 503);
	}
	await session.stmt.run();
	return c.json({ ok: true, login: user?.login ?? "", session_token: session.token });
});

// Full ban list so the plugin can reconcile its local list (safety net for missed /ban hooks).
app.get("/api/v1/bans", async (c) => {
	const { results } = await c.env.DB.prepare("SELECT u.uuid AS mc_uuid, u.mc_name, b.reason, b.source FROM bans b JOIN users u USING (ft_id)").all();
	return c.json({ bans: results });
});

// --- browser: limbo code -> 42 authorize -> callback ---
app.get("/link/:code", async (c) => {
	const row = await c.env.DB.prepare("SELECT code FROM limbo_codes WHERE code = ? AND ft_id IS NULL AND expires_at > ?").bind(c.req.param("code"), nowMs()).first<{ code: string }>();
	if (!row) return c.html(page("Link expired", "Join the Minecraft server again to get a new link."), 410);
	c.header("Cache-Control", "no-store");
	return c.html(signInPage(`/link/${encodeURIComponent(row.code)}/authorize`));
});

app.get("/link/:code/authorize", async (c) => {
	const row = await c.env.DB.prepare("SELECT code FROM limbo_codes WHERE code = ? AND ft_id IS NULL AND expires_at > ?").bind(c.req.param("code"), nowMs()).first<{ code: string }>();
	if (!row) return c.html(page("Link expired", "Join the Minecraft server again to get a new link."), 410);
	const state = randomToken();
	await c.env.DB.prepare("INSERT INTO oauth_states (state, link_code, expires_at) VALUES (?, ?, ?)").bind(state, row.code, nowMs() + LINK_TTL_MS).run();
	c.header("Cache-Control", "no-store");
	return c.redirect(authorizeUrl(c.env.FT_CLIENT_ID, `${c.env.PUBLIC_URL}/auth/callback`, state));
});

app.get("/auth/callback", async (c) => {
	c.header("Cache-Control", "no-store");
	c.header("Referrer-Policy", "no-referrer");
	const db = c.env.DB;
	const state = c.req.query("state");
	const code = c.req.query("code");
	if (c.req.query("error") || !state || !code) return c.html(page("Sign-in cancelled", "42 did not authorize the request."), 400);

	// State is single-use. A state with link_code "web" is the /me sign-in; anything else is a limbo code.
	const st = await db.prepare("DELETE FROM oauth_states WHERE state = ? AND expires_at > ? RETURNING link_code").bind(state, nowMs()).first<{ link_code: string }>();
	if (!st) return c.html(page("Sign-in request expired or already used", "This sign-in link has expired or was already processed. If Minecraft has admitted you, you can close this tab. Otherwise, rejoin the server and use the new link in chat. Keep the sign-in page open so you can retry from there; reloading this callback cannot start a new sign-in."), 400);
	const isWeb = st.link_code === "web";
	if (!isWeb) {
		// Claim the limbo code atomically (ft_id 0 = sign-in in progress).
		const limbo = await db.prepare("UPDATE limbo_codes SET ft_id = 0 WHERE code = ? AND ft_id IS NULL AND expires_at > ? RETURNING code").bind(st.link_code, nowMs()).first<{ code: string }>();
		if (!limbo) return c.html(page("Link expired", "Join the Minecraft server again to get a new link."), 410);
	}

	// Past this point a limbo code is claimed: any rejection must tell the waiting guest.
	const reject = async (title: string, body: string, status: 400 | 403 | 409 | 502) => {
		if (!isWeb) await db.prepare("UPDATE limbo_codes SET ft_id = -1 WHERE code = ?").bind(st.link_code).run();
		return c.html(page(title, body), status);
	};

	let me;
	try {
		me = await fetchMe(await exchangeCode(c.env, code, `${c.env.PUBLIC_URL}/auth/callback`));
	} catch {
		return reject("42 error", "Could not verify your 42 account. Try again.", 502);
	}
	const browser = { ft_id: me.id, login: me.login, mc_uuid: ftIdToUuid(me.id), mc_name: mcNameFromLogin(me.login), ...browserContext(c) };
	const denied = (detail: string) => recordLoginBestEffort(db, { ...browser, event: "oauth_denied", detail: `${isWeb ? "web" : "game"}: ${detail}` });
	if (!isEligible(me, String(c.env.ALLOW_STAFF) === "true")) {
		await denied("not eligible");
		return reject("Not eligible", "This server is for current 42 students.", 403);
	}
	if (await db.prepare("SELECT 1 FROM bans WHERE ft_id = ?").bind(me.id).first()) {
		await denied("banned");
		return reject("Banned", "This 42 account is banned from the server.", 403);
	}

	// The in-game name is always the 42 login (hyphens -> underscores); whatever name the client typed is ignored.
	const mcName = mcNameFromLogin(me.login);
	if (!mcName) return reject("Unsupported login", `Your 42 login <b>${escapeHtml(me.login)}</b> cannot be used as a Minecraft name. Ask an admin.`, 409);
	try {
		// First sign-in creates the user; later ones follow a changed login. The UUID never changes.
		await db
			.prepare("INSERT INTO users (ft_id, login, uuid, mc_name, created_at, special_title) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(ft_id) DO UPDATE SET login = excluded.login, mc_name = excluded.mc_name, special_title = excluded.special_title")
			.bind(me.id, me.login, ftIdToUuid(me.id), mcName, nowMs(), selectedTitle(me))
			.run();
	} catch {
		// UNIQUE(mc_name) tripped: two 42 accounts mapping to one name. Fail loudly rather than merge them.
		await denied("name conflict");
		return reject("Name conflict", `The name <b>${escapeHtml(mcName)}</b> is already used by another account. Ask an admin.`, 409);
	}

	const t = isWeb ? null : await mintToken(c.env, me.id);
	try {
		await recordLogin(db, { ...browser, event: isWeb ? "oauth_web" : "oauth_game", token_hash: t ? await sha256Hex(t.token) : null });
	} catch (e) {
		console.error("auth/callback: login audit unavailable", String(e));
		return reject("Sign-in unavailable", "Sign-in could not be recorded. Try again in a minute.", 502);
	}

	if (!t) {
		await startWebSession(c, me.id);
		return c.redirect("/me");
	}
	await db.batch([t.stmt, db.prepare("UPDATE limbo_codes SET ft_id = ?, pending_token = ? WHERE code = ?").bind(me.id, t.token, st.link_code)]);
	return c.html(page("Signed in", "Go back to Minecraft. You will be moved into the game in a moment."));
});

export default app;
