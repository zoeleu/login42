import type { Textures } from "./mojang";

const BASE = "https://api.mineskin.org";

// PNG sanity check before anything leaves the server: signature, IHDR size 64x64 or 64x32.
export function checkSkinPng(bytes: Uint8Array): string | null {
	if (bytes.length < 33 || bytes.length > 64 * 1024) return "The file must be a PNG under 64 KB.";
	const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	if (!sig.every((b, i) => bytes[i] === b)) return "That is not a PNG file.";
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (dv.getUint32(12) !== 0x49484452) return "Malformed PNG.";
	const w = dv.getUint32(16);
	const h = dv.getUint32(20);
	if (w !== 64 || (h !== 64 && h !== 32)) return "A skin must be 64x64 (or legacy 64x32) pixels.";
	return null;
}

// Signs a skin through MineSkin v2 (https://api.mineskin.org/v2/openapi.json): POST /v2/queue (multipart),
// then poll GET /v2/queue/{jobId} while it is 202. Uploaded as `unlisted` (not in public listings, but reachable by URL/uuid; `private` needs a paid MineSkin grant).
export async function signSkin(apiKey: string, png: Uint8Array, variant: "classic" | "slim"): Promise<Textures> {
	const headers = { authorization: `Bearer ${apiKey}`, "user-agent": "login42-server" };
	const form = new FormData();
	form.set("file", new Blob([png], { type: "image/png" }), "skin.png");
	form.set("variant", variant);
	form.set("visibility", "unlisted");
	let res = await fetch(`${BASE}/v2/queue`, { method: "POST", headers, body: form, signal: AbortSignal.timeout(20_000) });
	for (let i = 0; i < 20 && res.status === 202; i++) {
		const job = ((await res.json()) as { job?: { id: string } }).job;
		if (!job) break;
		await new Promise((r) => setTimeout(r, 1500));
		res = await fetch(`${BASE}/v2/queue/${encodeURIComponent(job.id)}`, { headers, signal: AbortSignal.timeout(20_000) });
	}
	if (res.status === 429) throw new Error("MineSkin is rate limiting; try again in a minute.");
	if (!res.ok) throw new Error(`MineSkin failed (${res.status}).`);
	const data = ((await res.json()) as { skin?: { texture?: { data?: { value?: string; signature?: string } } } }).skin?.texture?.data;
	if (!data?.value || !data.signature) throw new Error("MineSkin returned no signed texture yet; try again.");
	return { value: data.value, signature: data.signature };
}
