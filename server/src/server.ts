import app from "./index";
import { openDb } from "./lib/db";
import { migrate } from "./lib/migrate";

// Without these the service cannot authenticate anyone safely: refuse to start rather than run degraded.
const REQUIRED = ["PUBLIC_URL", "FT_CLIENT_ID", "FT_CLIENT_SECRET", "PLUGIN_HMAC_SECRET", "ADMIN_TOKEN"] as const;

const DEFAULTS = {
	MINESKIN_API_KEY: "",
	VERIFIER_ADDRESS: "",
	LIMBO_PER_MINUTE: "12",
	TOKEN_TTL_SECONDS: "120",
	ALLOW_STAFF: "false",
	PRIVACY_CONTACT: "",
};

export function loadEnv(source: Record<string, string | undefined>): Omit<Env, "DB"> {
	const missing = REQUIRED.filter((k) => !source[k]);
	if (missing.length) throw new Error(`missing required settings: ${missing.join(", ")}`);
	const env = { ...DEFAULTS } as Record<string, string>;
	for (const k of [...REQUIRED, ...Object.keys(DEFAULTS)]) if (source[k]) env[k] = source[k]!;
	return env as unknown as Omit<Env, "DB">;
}

if (import.meta.main) {
	const settings = loadEnv(process.env);
	const db = openDb(process.env.DB_PATH ?? "login42.sqlite");
	const applied = migrate(db);
	if (applied.length) console.log(`applied migrations: ${applied.join(", ")}`);
	const env: Env = { ...settings, DB: db };
	const server = Bun.serve({
		hostname: process.env.HOST ?? "127.0.0.1",
		port: Number(process.env.PORT ?? 8787),
		fetch: (req) => app.fetch(req, env),
	});
	console.log(`login42 listening on ${server.url}`);
	// As PID 1 in the container, SIGTERM is ignored unless handled: finish in-flight requests, then close
	// SQLite cleanly (checkpointing the WAL) so a restart never kills a login half-way.
	for (const signal of ["SIGTERM", "SIGINT"] as const) {
		process.on(signal, async () => {
			await server.stop();
			db.sqlite.close();
			process.exit(0);
		});
	}
}
