import { nowMs } from "./util";
import type { Database } from "./db";

// Shared by the plugin API (ban by uuid) and the admin API (ban by login).
export async function banUser(db: Database, ftId: number, reason: string | null, source: string | null): Promise<void> {
	await db.batch([
		db.prepare("INSERT OR REPLACE INTO bans (ft_id, reason, source, created_at) VALUES (?, ?, ?, ?)").bind(ftId, reason, source, nowMs()),
		db.prepare("DELETE FROM tokens WHERE ft_id = ?").bind(ftId),
		db.prepare("INSERT INTO audit_log (at, ft_id, action, detail) VALUES (?, ?, 'ban', ?)").bind(nowMs(), ftId, source),
	]);
}

export async function pardonUser(db: Database, ftId: number, source: string | null): Promise<void> {
	await db.batch([
		db.prepare("DELETE FROM bans WHERE ft_id = ?").bind(ftId),
		db.prepare("INSERT INTO audit_log (at, ft_id, action, detail) VALUES (?, ?, 'pardon', ?)").bind(nowMs(), ftId, source),
	]);
}
