import { randomToken } from "./util";

const enc = new TextEncoder();

export async function sha256Hex(s: string): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 256 bits of randomness; high-entropy so a plain SHA-256 at rest is sufficient.
export const newSessionToken = () => randomToken(32);
