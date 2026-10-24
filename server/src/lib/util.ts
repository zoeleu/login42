export const nowMs = () => Date.now();

export function randomToken(bytes = 24): string {
	const b = crypto.getRandomValues(new Uint8Array(bytes));
	return btoa(String.fromCharCode(...b)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

// Short, human-typeable code for the in-game link URL.
export function linkCode(): string {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	const b = crypto.getRandomValues(new Uint8Array(10));
	return [...b].map((x) => alphabet[x % alphabet.length]).join("");
}

// Names the client may present at join. Vanilla already restricts these; the bound name is not taken from them.
export const MC_NAME_RE = /^[A-Za-z0-9_]{1,16}$/;

// The in-game name of a 42 user: their login with hyphens mapped to underscores.
// Returns null if the result is not a valid Minecraft name (the caller must reject, never guess).
export function mcNameFromLogin(login: string): string | null {
	const name = login.replaceAll("-", "_");
	return MC_NAME_RE.test(name) ? name : null;
}

export const escapeHtml = (s: string) =>
	s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function page(title: string, body: string): string {
	return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem}</style>
<h1>${escapeHtml(title)}</h1><p>${body}</p>
<footer style="margin-top:3rem;font-size:.85rem;opacity:.8"><a href="/">42craft</a> · <a href="/privacy">Privacy</a> · <a href="/privacidade">Privacidade</a></footer>`;
}
