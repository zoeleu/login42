import { ERASURE_DELAY_MS } from "./audit";
import { nowMs } from "./util";
import type { Database } from "./db";

// Deletes an account and anonymizes what refers to it. login_audit is the exception: those rows are scheduled
// for redaction ERASURE_DELAY_MS later, so abuse committed shortly before deletion can still be investigated.
// Bans are kept and block deletion: erasing one would let the person back in.
export async function deleteAccount(db: Database, ftId: number, source: "self" | "admin"): Promise<"ok" | "unknown" | "banned"> {
	if (!(await db.prepare("SELECT 1 FROM users WHERE ft_id = ?").bind(ftId).first())) return "unknown";
	if (await db.prepare("SELECT 1 FROM bans WHERE ft_id = ?").bind(ftId).first()) return "banned";
	const premium = await db.prepare("SELECT mojang_uuid FROM premium_accounts WHERE ft_id = ?").bind(ftId).first<{ mojang_uuid: string }>();
	const now = nowMs();
	await db.batch([
		db.prepare("INSERT INTO login_audit_erasure (ft_id, mojang_uuid, requested_at, erase_after, up_to_id) VALUES (?, ?, ?, ?, (SELECT max(id) FROM login_audit))").bind(ftId, premium?.mojang_uuid ?? null, now, now + ERASURE_DELAY_MS),
		db.prepare("DELETE FROM tokens WHERE ft_id = ?").bind(ftId),
		db.prepare("DELETE FROM premium_tokens WHERE ft_id = ?").bind(ftId),
		db.prepare("DELETE FROM web_sessions WHERE ft_id = ?").bind(ftId),
		db.prepare("DELETE FROM premium_accounts WHERE ft_id = ?").bind(ftId),
		db.prepare("DELETE FROM skin_source WHERE ft_id = ?").bind(ftId),
		db.prepare("DELETE FROM limbo_codes WHERE ft_id = ?").bind(ftId),
		db.prepare("DELETE FROM mojang_cache WHERE mojang_uuid = ?").bind(premium?.mojang_uuid ?? null),
		db.prepare("DELETE FROM rate_limits WHERE key IN (?, ?, ?)").bind(`premium-start:${ftId}`, `premium-login:${ftId}`, `proof:${premium?.mojang_uuid ?? ""}`),
		db.prepare("UPDATE audit_log SET ft_id = NULL, detail = NULL WHERE ft_id = ?").bind(ftId),
		db.prepare("DELETE FROM users WHERE ft_id = ?").bind(ftId),
		db.prepare("INSERT INTO audit_log (at, ft_id, action, detail) VALUES (?, NULL, 'account_deleted', ?)").bind(now, source),
	]);
	return "ok";
}
