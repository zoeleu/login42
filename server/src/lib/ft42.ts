// Subset of GET /v2/me used here (https://api.intra.42.fr/apidoc/2.0/users/me.html).
export interface FtMe {
	id: number;
	login: string;
	kind: string;
	"staff?": boolean;
	"alumni?": boolean;
	"active?": boolean;
	titles?: { id: number; name: string }[];
	titles_users?: { title_id: number; selected: boolean }[];
}

// Intra exposes all earned titles, plus the user's currently selected title separately.
// Keep this plain text: neither Intra titles nor player messages are formatting markup.
export function selectedTitle(me: Pick<FtMe, "login" | "titles" | "titles_users">): string | null {
	const selected = me.titles_users?.find((t) => t.selected === true);
	const title = selected && me.titles?.find((t) => t.id === selected.title_id)?.name;
	if (!title) return null;
	return title.replaceAll("%login", me.login).replace(/[\u0000-\u001f\u007f-\u009f\u00a7]/g, "").trim().slice(0, 256) || null;
}

export const AUTHORIZE_URL = "https://api.intra.42.fr/oauth/authorize";
export const TOKEN_URL = "https://api.intra.42.fr/oauth/token";
export const ME_URL = "https://api.intra.42.fr/v2/me";

export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
	const u = new URL(AUTHORIZE_URL);
	u.search = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: "public",
		state,
	}).toString();
	return u.toString();
}

// Current-student rule. Default: kind=student, active, not alumni. Staff admitted only if allowStaff.
// Verify against a real /v2/me response (see plan): field semantics come from the apidoc sample.
export function isEligible(me: FtMe, allowStaff: boolean): boolean {
	if (me["staff?"] || me.kind === "admin") return allowStaff;
	return me.kind === "student" && me["active?"] === true && me["alumni?"] !== true;
}

export async function exchangeCode(env: Env, code: string, redirectUri: string): Promise<string> {
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		signal: AbortSignal.timeout(8000),
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: env.FT_CLIENT_ID,
			client_secret: env.FT_CLIENT_SECRET,
			code,
			redirect_uri: redirectUri,
		}),
	});
	if (!res.ok) throw new Error(`42 token exchange failed: ${res.status}`);
	return ((await res.json()) as { access_token: string }).access_token;
}

export async function fetchMe(accessToken: string): Promise<FtMe> {
	const res = await fetch(ME_URL, { signal: AbortSignal.timeout(8000), headers: { authorization: `Bearer ${accessToken}` } });
	if (!res.ok) throw new Error(`42 /v2/me failed: ${res.status}`);
	return (await res.json()) as FtMe;
}

// Returning premium players prove their Mojang identity on the game server; eligibility is still
// checked against their linked 42 account on each login, without requiring a browser OAuth round trip.
export async function fetchUserById(env: Env, id: number): Promise<FtMe | null> {
	if (!Number.isSafeInteger(id) || id <= 0) return null;
	const res = await fetch(`https://api.intra.42.fr/v2/users/${id}`, { signal: AbortSignal.timeout(8000), headers: { authorization: `Bearer ${await appToken(env)}` } });
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`42 user lookup failed: ${res.status}`);
	return (await res.json()) as FtMe;
}

// --- application token (client credentials), used by admin lookups of users who never signed in ---
export interface FtUser {
	id: number;
	login: string;
}

// Cached per isolate; the token lives 7200s (42 apidoc: guides/getting_started).
let appTokenCache: { token: string; expiresAt: number } | null = null;

export async function appToken(env: Env): Promise<string> {
	if (appTokenCache && appTokenCache.expiresAt > Date.now() + 60_000) return appTokenCache.token;
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		signal: AbortSignal.timeout(8000),
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.FT_CLIENT_ID, client_secret: env.FT_CLIENT_SECRET }),
	});
	if (!res.ok) throw new Error(`42 client_credentials failed: ${res.status}`);
	const j = (await res.json()) as { access_token: string; expires_in: number };
	appTokenCache = { token: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
	return j.access_token;
}

// null if the login does not exist. Logins are lowercase letters/digits/hyphen; refuse anything else
// so a crafted value can never alter the request path.
export async function fetchUserByLogin(env: Env, login: string): Promise<FtUser | null> {
	if (!/^[a-z0-9-]{1,32}$/.test(login)) return null;
	const res = await fetch(`https://api.intra.42.fr/v2/users/${login}`, { signal: AbortSignal.timeout(8000), headers: { authorization: `Bearer ${await appToken(env)}` } });
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`42 user lookup failed: ${res.status}`);
	const u = (await res.json()) as FtUser;
	return { id: u.id, login: u.login };
}
