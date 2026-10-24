const enc = new TextEncoder();

const toHex = (buf: ArrayBuffer) =>
	[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function key(secret: string) {
	return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
		"verify",
	]);
}

export async function hmacHex(secret: string, message: string): Promise<string> {
	return toHex(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(message)));
}

// Constant-time verify of a hex signature.
export async function hmacVerify(secret: string, message: string, sigHex: string): Promise<boolean> {
	if (!/^[0-9a-f]{64}$/.test(sigHex)) return false;
	const sig = new Uint8Array(sigHex.match(/../g)!.map((h) => parseInt(h, 16)));
	return crypto.subtle.verify("HMAC", await key(secret), sig, enc.encode(message));
}

export const signingString = (ts: string, method: string, path: string, body: string) =>
	`${ts}.${method.toUpperCase()}.${path}.${body}`;

export const MAX_SKEW_MS = 30_000;
