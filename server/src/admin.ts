import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { fetchUserByLogin } from "./lib/ft42";
import { banUser, pardonUser } from "./lib/bans";
import { verifyChain } from "./lib/audit";
import { deleteAccount } from "./lib/account";
import { mcNameFromLogin, nowMs } from "./lib/util";
import { ftIdToUuid } from "./lib/uuid";

interface UserRow {
	ft_id: number;
	login: string;
	uuid: string;
	mc_name: string;
}

// Admin API, authenticated with a single bearer token (ADMIN_TOKEN). Keep it off the public internet
// where possible (Cloudflare Access / IP allowlist in front of /admin).
export const admin = new Hono<{ Bindings: Env }>();

const enc = new TextEncoder();

async function sameSecret(a: string, b: string): Promise<boolean> {
	// Compare fixed-length digests so length and content differences are not observable by timing.
	const [da, db] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
	return timingSafeEqual(new Uint8Array(da), new Uint8Array(db));
}

admin.use("*", async (c, next) => {
	const given = (c.req.header("authorization") ?? "").replace(/^Bearer /, "");
	if (!c.env.ADMIN_TOKEN || !given || !(await sameSecret(given, c.env.ADMIN_TOKEN))) return c.json({ error: "unauthorized" }, 401);
	await next();
});

const normLogin = (s: string) => s.trim().toLowerCase();

// Finds the user by login, creating the row from the 42 API if they never signed in (so a ban can exist
// before the person ever joins; the callback will reject them as banned).
async function ensureUser(c: { env: Env }, login: string): Promise<UserRow | "unknown" | "unusable"> {
	const have = await c.env.DB.prepare("SELECT * FROM users WHERE login = ?").bind(login).first<UserRow>();
	if (have) return have;
	const u = await fetchUserByLogin(c.env, login);
	if (!u) return "unknown";
	const name = mcNameFromLogin(u.login);
	if (!name) return "unusable";
	await c.env.DB.prepare("INSERT INTO users (ft_id, login, uuid, mc_name, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(ft_id) DO NOTHING")
		.bind(u.id, u.login, ftIdToUuid(u.id), name, nowMs())
		.run();
	return (await c.env.DB.prepare("SELECT * FROM users WHERE ft_id = ?").bind(u.id).first<UserRow>())!;
}

admin.post("/bans", async (c) => {
	const b = await c.req.json<{ login?: string; reason?: string }>().catch(() => null);
	if (!b?.login) return c.json({ error: "login required" }, 400);
	const u = await ensureUser(c, normLogin(b.login));
	if (u === "unknown") return c.json({ error: "no such 42 login" }, 404);
	if (u === "unusable") return c.json({ error: "login cannot be a Minecraft name" }, 409);
	await banUser(c.env.DB, u.ft_id, b.reason ?? null, "admin");
	return c.json({ ok: true, ft_id: u.ft_id, uuid: u.uuid });
});

admin.delete("/bans/:login", async (c) => {
	const u = await c.env.DB.prepare("SELECT * FROM users WHERE login = ?").bind(normLogin(c.req.param("login"))).first<UserRow>();
	if (!u) return c.json({ error: "unknown user" }, 404);
	await pardonUser(c.env.DB, u.ft_id, "admin");
	return c.json({ ok: true });
});

admin.get("/users/:login", async (c) => {
	const u = await c.env.DB.prepare("SELECT u.ft_id, u.login, u.uuid, u.mc_name, u.created_at, b.reason AS ban_reason FROM users u LEFT JOIN bans b USING (ft_id) WHERE u.login = ?")
		.bind(normLogin(c.req.param("login")))
		.first();
	return u ? c.json(u) : c.json({ error: "unknown user" }, 404);
});

// Delete and anonymize a user, as the self-service button does (a later sign-in creates a fresh row; the UUID
// is unchanged since it derives from the id). Login records are redacted 6 months later, not now.
admin.delete("/users/:login", async (c) => {
	const u = await c.env.DB.prepare("SELECT * FROM users WHERE login = ?").bind(normLogin(c.req.param("login"))).first<UserRow>();
	if (!u) return c.json({ error: "unknown user" }, 404);
	const result = await deleteAccount(c.env.DB, u.ft_id, "admin");
	if (result === "banned") return c.json({ error: "user is banned: pardon first" }, 409);
	return result === "ok" ? c.json({ ok: true }) : c.json({ error: "unknown user" }, 404);
});

admin.get("/audit", async (c) => {
	const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 500);
	const { results } = await c.env.DB.prepare("SELECT id, at, ft_id, action, detail FROM audit_log ORDER BY id DESC LIMIT ?").bind(limit).all();
	return c.json({ audit: results });
});

// Authentication records (login_audit). Filters combine; `login` also matches records made under an earlier login.
// Times are epoch milliseconds. Raw IPs are personal data: query only for an actual abuse investigation.
admin.get("/logins", async (c) => {
	const q = c.req.query();
	const where: string[] = [];
	const args: (string | number)[] = [];
	if (q.login) {
		where.push("(login = ? OR ft_id = (SELECT ft_id FROM users WHERE login = ?))");
		args.push(normLogin(q.login), normLogin(q.login));
	}
	if (q.mc_name) {
		where.push("(mc_name = ? COLLATE NOCASE OR client_name = ? COLLATE NOCASE)");
		args.push(q.mc_name, q.mc_name);
	}
	for (const f of ["ip", "token_hash", "event", "mc_uuid"] as const) {
		if (q[f]) {
			where.push(`${f} = ?`);
			args.push(q[f]);
		}
	}
	if (q.mojang_uuid) {
		where.push("mojang_uuid = ?");
		args.push(q.mojang_uuid.replaceAll("-", "").toLowerCase());
	}
	if (q.since) {
		where.push("at >= ?");
		args.push(Number(q.since) || 0);
	}
	if (q.until) {
		where.push("at <= ?");
		args.push(Number(q.until) || 0);
	}
	const limit = Math.min(Math.max(Number(q.limit ?? 100) || 100, 1), 1000);
	const { results } = await c.env.DB.prepare(`SELECT * FROM login_audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).bind(...args, limit).all();
	return c.json({ logins: results });
});

// Recomputes the hash chain. Compare `head` with the latest "Login audit #..." lines in the game server log.
admin.get("/logins/verify", async (c) => c.json(await verifyChain(c.env.DB)));
