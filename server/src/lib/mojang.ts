import { nowMs } from "./util";
import type { Database } from "./db";

const CACHE_MS = 10 * 60_000;

export interface Textures {
	value: string;
	signature: string;
}

// Signed textures for a Mojang account, cached so joins do not hammer Mojang's rate limits.
// `unsigned=false` asks for the Yggdrasil signature (https://minecraft.wiki/w/Mojang_API).
export async function mojangTextures(db: Database, mojangUuid: string): Promise<Textures | null> {
	const id = mojangUuid.replaceAll("-", "").toLowerCase();
	if (!/^[0-9a-f]{32}$/.test(id)) return null;
	const cached = await db.prepare("SELECT value, signature, fetched_at FROM mojang_cache WHERE mojang_uuid = ?").bind(id).first<{ value: string | null; signature: string | null; fetched_at: number }>();
	if (cached && cached.fetched_at > nowMs() - CACHE_MS) return cached.value && cached.signature ? { value: cached.value, signature: cached.signature } : null;

	// Bounded: this runs inside join-check, which the plugin abandons after its own timeout.
	const res = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${id}?unsigned=false`, { signal: AbortSignal.timeout(3000) });
	if (res.status === 429 && cached?.value && cached.signature) return { value: cached.value, signature: cached.signature }; // stale beats nothing
	if (res.status === 204 || res.status === 404) return null; // no such profile
	if (!res.ok) throw new Error(`mojang profile lookup returned HTTP ${res.status}`); // visible to the caller, never swallowed
	const p = (await res.json()) as { properties?: { name: string; value: string; signature?: string }[] };
	const t = p.properties?.find((x) => x.name === "textures");
	const out = t?.signature ? { value: t.value, signature: t.signature } : null;
	await db.prepare("INSERT OR REPLACE INTO mojang_cache (mojang_uuid, value, signature, fetched_at) VALUES (?, ?, ?, ?)").bind(id, out?.value ?? null, out?.signature ?? null, nowMs()).run();
	return out;
}
