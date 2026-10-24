import type { Database } from "./lib/db";

// Bindings available to routes as c.env. Built from process.env by src/server.ts (see .env.example).
declare global {
	interface Env {
		DB: Database;
		FT_CLIENT_ID: string;
		FT_CLIENT_SECRET: string;
		PLUGIN_HMAC_SECRET: string;
		ADMIN_TOKEN: string;
		// Optional: without it, skin upload is disabled (premium skins still work).
		MINESKIN_API_KEY: string;
		// host:port players connect to for the one-time premium proof. Empty hides premium linking.
		VERIFIER_ADDRESS: string;
		LIMBO_PER_MINUTE: string;
		PUBLIC_URL: string;
		// A token only has to survive the limbo -> transfer handoff (cookies do not outlive a manual reconnect).
		TOKEN_TTL_SECONDS: string;
		ALLOW_STAFF: string;
		// Shown on /privacidade and /privacy as the LGPD contact channel.
		PRIVACY_CONTACT: string;
	}
}

export {};
