import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context } from "hono";
import { hmacHex } from "./hmac";
import { sha256Hex } from "./token";
import { escapeHtml, nowMs, page, randomToken } from "./util";

// Keep a stable first-party tab available if the external Intra sign-in flow loses its OAuth query.
// Each click goes through our start route again and issues a fresh state and complete authorize URL.
export function signInPage(startPath: string): string {
	return page("Sign in with 42", `<a href="${escapeHtml(startPath)}" target="_blank" rel="noopener" style="display:inline-block;padding:.7rem 1rem;background:#007f82;color:white;text-decoration:none;border-radius:.3rem">Continue with 42</a></p>
<p>42 opens in a separate tab. After signing in, return to Minecraft.</p>
<p>If 42 shows an authorization error, finish signing in to your Intra account, then return to this tab and click <b>Continue with 42</b> again. This creates a fresh sign-in request; do not open <code>api.intra.42.fr/oauth/authorize</code> on its own.</p>
<p><a href="https://profile.intra.42.fr/" target="_blank" rel="noopener">Open 42 Intra to sign in</a>`);
}

const COOKIE = "login42_sid";
const SESSION_MS = 8 * 3_600_000;

export async function startWebSession(c: Context<{ Bindings: Env }>, ftId: number): Promise<void> {
	const id = randomToken(32);
	await c.env.DB.prepare("INSERT INTO web_sessions (id_hash, ft_id, expires_at) VALUES (?, ?, ?)").bind(await sha256Hex(id), ftId, nowMs() + SESSION_MS).run();
	setCookie(c, COOKIE, id, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: SESSION_MS / 1000, secure: c.env.PUBLIC_URL.startsWith("https://") });
}

export async function endWebSession(c: Context<{ Bindings: Env }>): Promise<void> {
	const id = getCookie(c, COOKIE);
	if (id) await c.env.DB.prepare("DELETE FROM web_sessions WHERE id_hash = ?").bind(await sha256Hex(id)).run();
	deleteCookie(c, COOKIE, { path: "/" });
}

export interface WebUser {
	ft_id: number;
	login: string;
	mc_name: string;
	uuid: string;
	csrf: string;
}

export async function webUser(c: Context<{ Bindings: Env }>): Promise<WebUser | null> {
	const id = getCookie(c, COOKIE);
	if (!id) return null;
	const row = await c.env.DB
		.prepare("SELECT u.ft_id, u.login, u.mc_name, u.uuid FROM web_sessions s JOIN users u USING (ft_id) WHERE s.id_hash = ? AND s.expires_at > ?")
		.bind(await sha256Hex(id), nowMs())
		.first<Omit<WebUser, "csrf">>();
	return row ? { ...row, csrf: await hmacHex(c.env.PLUGIN_HMAC_SECRET, `csrf:${id}`) } : null;
}
