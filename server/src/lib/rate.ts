import { hmacHex } from "./hmac";
import { nowMs } from "./util";
import type { Database } from "./db";

const WINDOW_MS = 60_000;

// Fixed-window counter in SQLite. Returns true if this hit is within the limit.
export async function allow(db: Database, key: string, limit: number): Promise<boolean> {
	const window = Math.floor(nowMs() / WINDOW_MS);
	const row = await db
		.prepare("INSERT INTO rate_limits (key, window, count) VALUES (?, ?, 1) ON CONFLICT(key, window) DO UPDATE SET count = count + 1 RETURNING count")
		.bind(key, window)
		.first<{ count: number }>();
	// Opportunistic cleanup of old windows.
	if (Math.random() < 0.02) await db.prepare("DELETE FROM rate_limits WHERE window < ?").bind(window - 5).run();
	return (row?.count ?? 1) <= limit;
}

// Stable, non-reversible key for an IP, so raw addresses are not stored.
export const ipKey = (secret: string, ip: string) => hmacHex(secret, `ip:${ip}`);
