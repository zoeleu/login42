import { Hono, type Context } from "hono";
import { authorizeUrl } from "./lib/ft42";
import { checkSkinPng, signSkin } from "./lib/mineskin";
import { linkPremium } from "./lib/premium";
import { browserContext, recordLogin, recordLoginBestEffort } from "./lib/audit";
import { deleteAccount } from "./lib/account";
import { escapeHtml, nowMs, page, randomToken } from "./lib/util";
import { endWebSession, signInPage, webUser, type WebUser } from "./lib/web";

type Ctx = Context<{ Bindings: Env }>;

// Self-service pages for signed-in players: skin upload and linking a verified premium account.
export const me = new Hono<{ Bindings: Env }>();

const STATE_TTL_MS = 10 * 60_000;

me.get("/login", async (c) => {
	c.header("Cache-Control", "no-store");
	return c.html(signInPage("/me/authorize"));
});

me.get("/authorize", async (c) => {
	const state = randomToken();
	await c.env.DB.prepare("INSERT INTO oauth_states (state, link_code, expires_at) VALUES (?, 'web', ?)").bind(state, nowMs() + STATE_TTL_MS).run();
	c.header("Cache-Control", "no-store");
	return c.redirect(authorizeUrl(c.env.FT_CLIENT_ID, `${c.env.PUBLIC_URL}/auth/callback`, state));
});

async function skinSummary(c: Ctx, u: WebUser): Promise<string> {
	const s = await c.env.DB.prepare("SELECT kind, mojang_uuid FROM skin_source WHERE ft_id = ?").bind(u.ft_id).first<{ kind: string; mojang_uuid: string | null }>();
	if (!s || s.kind === "default") return "Default skin (the game picks one from your UUID).";
	if (s.kind === "upload") return "Your uploaded skin.";
	return `Premium account <code>${escapeHtml(s.mojang_uuid ?? "")}</code> (ownership verified through Mojang).`;
}

function form(u: WebUser, action: string, inner: string, multipart = false): string {
	return `<form method="post" action="${action}"${multipart ? ' enctype="multipart/form-data"' : ""}><input type="hidden" name="csrf" value="${u.csrf}">${inner}</form>`;
}

async function premiumSection(c: Ctx, u: WebUser): Promise<string> {
	if (!c.env.VERIFIER_ADDRESS) return "";
	const linked = await c.env.DB.prepare("SELECT mojang_uuid FROM premium_accounts WHERE ft_id = ?").bind(u.ft_id).first<{ mojang_uuid: string }>();
	return `<h2>Premium account</h2>
${linked ? `<p>Linked account: <code>${escapeHtml(linked.mojang_uuid)}</code>. Reconnect using your normal server entry with this Minecraft account to sign in automatically through Mojang, without opening the browser. Your 42 eligibility is checked each time. The link stays active if you change your skin. <code>${escapeHtml(c.env.VERIFIER_ADDRESS)}</code> is also available as a direct premium entry.</p>` : `<p>Own the game on a Mojang/Microsoft account? After signing in through 42, type <code>/premium</code> in game to link it. Alternatively, connect to <code>${escapeHtml(c.env.VERIFIER_ADDRESS)}</code> with that account and enter the one-time code below. Once linked, normal connections with that Minecraft account no longer need browser sign-in.</p>`}
${form(u, "/me/premium/link", `<p><input name="code" placeholder="Code" maxlength="12" autocomplete="off" required> <button>Link premium account</button></p>`)}
${form(u, "/me/premium/unlink", "<p><button>Unlink premium account</button></p>")}`;
}

async function renderHome(c: Ctx, u: WebUser, notice = ""): Promise<Response> {
	const upload = c.env.MINESKIN_API_KEY
		? form(u, "/me/skin", `<p><input type="file" name="file" accept="image/png" required> <select name="variant"><option value="classic">Classic (wide arms)</option><option value="slim">Slim (narrow arms)</option></select> <button>Upload skin</button></p>`, true)
		: "<p><em>Skin upload is not configured on this server.</em></p>";
	const body = `<p>Signed in as <b>${escapeHtml(u.login)}</b>. In game you are <b>${escapeHtml(u.mc_name)}</b>.</p>
${notice ? `<p><b>${escapeHtml(notice)}</b></p>` : ""}
<h2>Skin</h2><p>${await skinSummary(c, u)}</p>
${upload}
${form(u, "/me/skin/default", "<p><button>Use the default skin</button></p>")}
${await premiumSection(c, u)}
${form(u, "/me/logout", "<p><button>Sign out</button></p>")}
<h2>Delete account</h2>
<p>Deletes your profile, skin, premium link and sessions, and anonymizes their history. Sign-in records (time, IP address, Minecraft profile) are kept for 6 months after deletion for abuse investigations, then erased; see the <a href="/privacy">privacy policy</a>. Your world progress lives on the game server and is not deleted here. Signing in again later creates a new account.</p>
${form(u, "/me/delete", `<p><label><input type="checkbox" name="confirm" value="yes" required> I understand this cannot be undone</label> <button>Delete my account</button></p>`)}`;
	return c.html(page("Your Minecraft profile", body).replace("<h1>", '<h1 style="margin-bottom:0">'));
}

// Every state-changing handler needs the session and the CSRF token that was rendered into the form.
async function authed(c: Ctx): Promise<{ u: WebUser; body: Record<string, string | File> } | Response> {
	const u = await webUser(c);
	if (!u) return c.redirect("/me/login");
	const body = (await c.req.parseBody()) as Record<string, string | File>;
	if (body.csrf !== u.csrf) return c.html(page("Request rejected", "Reload the page and try again."), 403);
	return { u, body };
}

me.get("/", async (c) => {
	const u = await webUser(c);
	return u ? renderHome(c, u) : c.redirect("/me/login");
});

me.post("/skin", async (c) => {
	const a = await authed(c);
	if (a instanceof Response) return a;
	if (!c.env.MINESKIN_API_KEY) return renderHome(c, a.u, "Skin upload is not configured.");
	const file = a.body.file;
	if (!(file instanceof File)) return renderHome(c, a.u, "Choose a PNG file.");
	const bytes = new Uint8Array(await file.arrayBuffer());
	const problem = checkSkinPng(bytes);
	if (problem) return renderHome(c, a.u, problem);
	try {
		const t = await signSkin(c.env.MINESKIN_API_KEY, bytes, a.body.variant === "slim" ? "slim" : "classic");
		await c.env.DB
			.prepare("INSERT INTO skin_source (ft_id, kind, mojang_uuid, value, signature, verified_at, updated_at) VALUES (?, 'upload', NULL, ?, ?, NULL, ?) ON CONFLICT(ft_id) DO UPDATE SET kind='upload', mojang_uuid=NULL, value=excluded.value, signature=excluded.signature, verified_at=NULL, updated_at=excluded.updated_at")
			.bind(a.u.ft_id, t.value, t.signature, nowMs())
			.run();
		await c.env.DB.prepare("INSERT INTO audit_log (at, ft_id, action, detail) VALUES (?, ?, 'skin_upload', NULL)").bind(nowMs(), a.u.ft_id).run();
		return renderHome(c, a.u, "Skin updated. It will appear in game within about two minutes, or when you next join.");
	} catch (e) {
		return renderHome(c, a.u, e instanceof Error ? e.message : "Upload failed.");
	}
});

me.post("/skin/default", async (c) => {
	const a = await authed(c);
	if (a instanceof Response) return a;
	await c.env.DB.prepare("DELETE FROM skin_source WHERE ft_id = ?").bind(a.u.ft_id).run();
	return renderHome(c, a.u, "Using the default skin. It will appear in game within about two minutes, or when you next join.");
});

me.post("/premium/link", async (c) => {
	const a = await authed(c);
	if (a instanceof Response) return a;
	const code = String(a.body.code ?? "").trim().toUpperCase();
	// Single-use: the proof is consumed whether or not the link then succeeds.
	const proof = await c.env.DB.prepare("DELETE FROM premium_proofs WHERE code = ? AND expires_at > ? RETURNING mojang_uuid, mojang_name").bind(code, nowMs()).first<{ mojang_uuid: string; mojang_name: string }>();
	if (!proof) return renderHome(c, a.u, "That code is wrong or expired. Connect to the verifier again for a new one.");
	if ((await linkPremium(c.env.DB, a.u.ft_id, proof.mojang_uuid)) === "conflict") {
		return renderHome(c, a.u, "That Minecraft account is already linked to another player. Ask an admin if this is a mistake.");
	}
	await recordLoginBestEffort(c.env.DB, { event: "premium_link", ft_id: a.u.ft_id, login: a.u.login, mc_uuid: a.u.uuid, mc_name: a.u.mc_name, mojang_uuid: proof.mojang_uuid, mojang_name: proof.mojang_name, detail: "web code", ...browserContext(c) });
	return renderHome(c, a.u, `Linked ${proof.mojang_name}. Your skin will update in game within about two minutes, or when you next join.`);
});

me.post("/premium/unlink", async (c) => {
	const a = await authed(c);
	if (a instanceof Response) return a;
	await c.env.DB.batch([
		c.env.DB.prepare("DELETE FROM premium_accounts WHERE ft_id = ?").bind(a.u.ft_id),
		c.env.DB.prepare("DELETE FROM skin_source WHERE ft_id = ? AND kind = 'mojang'").bind(a.u.ft_id),
		c.env.DB.prepare("DELETE FROM tokens WHERE ft_id = ?").bind(a.u.ft_id),
		c.env.DB.prepare("DELETE FROM premium_tokens WHERE ft_id = ?").bind(a.u.ft_id),
	]);
	await c.env.DB.prepare("INSERT INTO audit_log (at, ft_id, action, detail) VALUES (?, ?, 'premium_unlink', NULL)").bind(nowMs(), a.u.ft_id).run();
	return renderHome(c, a.u, "Premium account unlinked.");
});

me.post("/logout", async (c) => {
	const a = await authed(c);
	if (a instanceof Response) return a;
	await endWebSession(c);
	return c.html(page("Signed out", "You are signed out."));
});

me.post("/delete", async (c) => {
	const a = await authed(c);
	if (a instanceof Response) return a;
	if (a.body.confirm !== "yes") return renderHome(c, a.u, "Tick the confirmation box to delete your account.");
	// Recorded before the deletion so the record falls inside the scheduled redaction.
	const premium = await c.env.DB.prepare("SELECT mojang_uuid FROM premium_accounts WHERE ft_id = ?").bind(a.u.ft_id).first<{ mojang_uuid: string }>();
	try {
		await recordLogin(c.env.DB, { event: "account_deleted", ft_id: a.u.ft_id, login: a.u.login, mc_uuid: a.u.uuid, mc_name: a.u.mc_name, mojang_uuid: premium?.mojang_uuid, detail: "self", ...browserContext(c) });
	} catch {
		return renderHome(c, a.u, "Deletion is temporarily unavailable. Try again in a minute.");
	}
	const result = await deleteAccount(c.env.DB, a.u.ft_id, "self");
	if (result === "banned") return renderHome(c, a.u, "A banned account cannot be deleted here. Contact the administrators.");
	await endWebSession(c);
	return c.html(page("Account deleted", "Your account was deleted. Sign-in records are erased 6 months from now."));
});
