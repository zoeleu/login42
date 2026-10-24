import type { Context } from "hono";
import { sha256Hex } from "./token";
import { nowMs } from "./util";
import type { Database, Statement } from "./db";

// Hash-chained authentication log (login_audit). Every row commits to the previous row's hash, so editing,
// removing or reordering earlier rows breaks verification. The plugin also writes each game login's hash
// into the game server log, a separate system, which makes truncating or rewriting the tail detectable.

export const GENESIS = "0".repeat(64);

export type LoginEventName =
	| "game_login" // a handoff token was consumed and the player entered as their 42 identity
	| "game_login_banned" // a valid token was presented by a banned account
	| "token_reuse" // an already-consumed token was presented again
	| "oauth_game" // 42 browser sign-in for a waiting limbo guest; token_hash is the token it issued
	| "oauth_web" // 42 browser sign-in for the /me profile pages
	| "oauth_denied" // 42 confirmed the account but it was refused (detail says why)
	| "premium_login" // Mojang-verified returning login; token_hash is the token it issued
	| "premium_login_denied"
	| "premium_proof" // Mojang-verified unlinked account received a linking code
	| "premium_link" // Mojang account linked to the 42 account
	| "account_deleted"; // the user (or an admin) deleted the account; earlier records are scheduled for redaction

export interface LoginEvent {
	event: LoginEventName;
	ft_id?: number | null;
	login?: string | null;
	mc_uuid?: string | null;
	mc_name?: string | null;
	ip?: string | null;
	ip_source?: "game" | "browser" | null;
	client_name?: string | null;
	client_uuid?: string | null;
	mojang_uuid?: string | null;
	mojang_name?: string | null;
	token_hash?: string | null;
	host?: string | null;
	user_agent?: string | null;
	detail?: string | null;
}

// Column order is part of the hash format. Append new columns at the end only.
const FIELDS = ["at", "event", "ft_id", "login", "mc_uuid", "ip", "ip_source", "client_name", "client_uuid", "mojang_uuid", "mojang_name", "token_hash", "host", "user_agent", "detail", "mc_name"] as const;
type Row = Record<(typeof FIELDS)[number], string | number | null>;

const LIMITS: Partial<Record<(typeof FIELDS)[number], number>> = { host: 255, user_agent: 256, detail: 200, client_name: 16, mojang_name: 16, mc_name: 16 };

export const canonical = (row: Row) => JSON.stringify(FIELDS.map((f) => row[f] ?? null));
export const chainHash = (prev: string, row: Row) => sha256Hex(`${prev}\n${canonical(row)}`);

// Addresses as reported by the plugin (TCP peer) or Caddy (browser). Anything else, including lists, is not stored.
export const cleanIp = (ip: unknown) => (typeof ip === "string" && ip.length <= 45 && /^[0-9A-Fa-f:.]+$/.test(ip) ? ip : null);
export const cleanText = (s: unknown, max: number) => (typeof s === "string" && s ? s.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max) : null);

// The service is published on loopback only, behind Caddy, which overwrites X-Forwarded-For with the client
// address it accepted from Cloudflare's ranges. CF-Connecting-IP is ignored: a direct request could forge it.
export function browserContext(c: Context): Pick<LoginEvent, "ip" | "ip_source" | "user_agent"> {
	return { ip: cleanIp(c.req.header("x-forwarded-for")), ip_source: "browser", user_agent: cleanText(c.req.header("user-agent"), 256) };
}

function toRow(e: LoginEvent): Row {
	const row = { at: nowMs() } as Row;
	for (const f of FIELDS) {
		if (f === "at") continue;
		const v = (e as unknown as Record<string, unknown>)[f];
		row[f] = typeof v === "number" ? v : typeof v === "string" ? (LIMITS[f] ? cleanText(v, LIMITS[f]!) : v) : null;
	}
	return row;
}

// Appends one record. Throws if it cannot be written: callers that admit someone or issue a credential must
// treat that as a failure (no record, no access). Concurrent writers race on UNIQUE(prev_hash) and retry.
export async function recordLogin(db: Database, e: LoginEvent): Promise<{ id: number; hash: string }> {
	const row = toRow(e);
	const cols = [...FIELDS, "prev_hash", "hash"];
	let lastError: unknown;
	for (let attempt = 0; attempt < 8; attempt++) {
		const last = await db.prepare("SELECT hash FROM login_audit ORDER BY id DESC LIMIT 1").first<{ hash: string }>();
		const prev = last?.hash ?? GENESIS;
		const hash = await chainHash(prev, row);
		try {
			const r = await db
				.prepare(`INSERT INTO login_audit (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) RETURNING id`)
				.bind(...FIELDS.map((f) => row[f]), prev, hash)
				.first<{ id: number }>();
			if (r) return { id: r.id, hash };
		} catch (err) {
			if (!/UNIQUE/i.test(String(err))) throw err;
			lastError = err;
		}
	}
	throw new Error(`login audit: could not append after retries: ${lastError}`);
}

// For callers where the audited action has already happened and cannot be refused (denials, web-side linking).
export async function recordLoginBestEffort(db: Database, e: LoginEvent): Promise<void> {
	try {
		await recordLogin(db, e);
	} catch (err) {
		console.error("login audit write failed", e.event, String(err));
	}
}

// Login records of a deleted account are kept this long after deletion, then redacted.
export const ERASURE_DELAY_MS = 183 * 86_400_000;

const PERSONAL = FIELDS.filter((f) => f !== "at" && f !== "event");

// Statements for an opportunistic purge (there is no cron): redact what is due, then forget the schedule.
export function redactionStatements(db: Database, now = nowMs()): Statement[] {
	return [
		db.prepare(`UPDATE login_audit SET ${PERSONAL.map((f) => `${f} = NULL`).join(", ")}, redacted_at = ? WHERE redacted_at IS NULL AND id IN (
			SELECT a.id FROM login_audit a JOIN login_audit_erasure e ON a.ft_id = e.ft_id OR (e.mojang_uuid IS NOT NULL AND a.mojang_uuid = e.mojang_uuid)
			WHERE e.erase_after <= ? AND (a.id <= e.up_to_id OR (e.up_to_id IS NULL AND a.at <= e.requested_at)))`).bind(now, now),
		db.prepare("DELETE FROM login_audit_erasure WHERE erase_after <= ?").bind(now),
	];
}

export interface ChainReport {
	ok: boolean;
	rows: number;
	redacted: number;
	first: { id: number; prev_hash: string } | null;
	head: { id: number; at: number; hash: string } | null;
	error?: { id: number; reason: string };
}

// Recomputes the whole chain. `first.prev_hash` is GENESIS unless the start of the log was removed.
export async function verifyChain(db: Database): Promise<ChainReport> {
	const report: ChainReport = { ok: true, rows: 0, redacted: 0, first: null, head: null };
	let prev: string | null = null;
	let after = 0;
	for (;;) {
		const { results } = await db.prepare(`SELECT id, ${FIELDS.join(", ")}, prev_hash, hash, redacted_at FROM login_audit WHERE id > ? ORDER BY id LIMIT 500`).bind(after).all<Row & { id: number; prev_hash: string; hash: string; redacted_at: number | null }>();
		if (!results.length) break;
		for (const r of results) {
			if (prev === null) report.first = { id: r.id, prev_hash: r.prev_hash };
			else if (r.prev_hash !== prev) return { ...report, ok: false, error: { id: r.id, reason: "prev_hash does not match the preceding row" } };
			// A redacted row can no longer be recomputed; its links to its neighbours are still checked.
			if (r.redacted_at) report.redacted++;
			else if ((await chainHash(r.prev_hash, r)) !== r.hash) return { ...report, ok: false, error: { id: r.id, reason: "row content does not match its hash" } };
			prev = r.hash;
			report.rows++;
			report.head = { id: r.id, at: r.at as number, hash: r.hash };
			after = r.id;
		}
	}
	if (report.first && report.first.prev_hash !== GENESIS) return { ...report, ok: false, error: { id: report.first.id, reason: "chain does not start at genesis" } };
	return report;
}
