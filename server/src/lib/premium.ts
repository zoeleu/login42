import { nowMs } from "./util";
import type { Database } from "./db";

// `textures` is the signed snapshot Mojang returned during the verified login; it is the fallback when a live lookup fails.
// Binds a Mojang account (proven by a real Mojang login) to a 42 user's skin source. One active claim per Mojang
// account: a second 42 user claiming it gets "conflict" and an audit entry, never a silent takeover.
export async function linkPremium(db: Database, ftId: number, mojangUuid: string, textures: { value: string; signature: string } | null = null): Promise<"ok" | "conflict"> {
	try {
		await db.batch([
			db.prepare("INSERT INTO premium_accounts (ft_id, mojang_uuid, verified_at) VALUES (?, ?, ?) ON CONFLICT(ft_id) DO UPDATE SET mojang_uuid=excluded.mojang_uuid, verified_at=excluded.verified_at").bind(ftId, mojangUuid, nowMs()),
			db.prepare("INSERT INTO skin_source (ft_id, kind, mojang_uuid, value, signature, verified_at, updated_at) VALUES (?, 'mojang', ?, ?, ?, ?, ?) ON CONFLICT(ft_id) DO UPDATE SET kind='mojang', mojang_uuid=excluded.mojang_uuid, value=excluded.value, signature=excluded.signature, verified_at=excluded.verified_at, updated_at=excluded.updated_at")
			.bind(ftId, mojangUuid, textures?.value ?? null, textures?.signature ?? null, nowMs(), nowMs())
		]);
	} catch {
		await db.prepare("INSERT INTO audit_log (at, ft_id, action, detail) VALUES (?, ?, 'premium_conflict', ?)").bind(nowMs(), ftId, mojangUuid).run();
		return "conflict";
	}
	await db.prepare("INSERT INTO audit_log (at, ft_id, action, detail) VALUES (?, ?, 'premium_link', ?)").bind(nowMs(), ftId, mojangUuid).run();
	return "ok";
}
