# Working on login42

This file is the repository's technical handoff. Keep `README.md` a brief project presentation;
put operational details here. Read the current source before changing behavior: old plans,
transcripts, comments, and installed configuration can lag behind it.

## Scope and architecture

Only eligible current 42 students may enter the game. Minecraft runs in offline mode to support
clients without Microsoft authentication. A separate Hono service on Cloudflare Workers and D1
owns identities, 42 OAuth, bans, transfer credentials, account links, and web profiles. The Java
Paper plugin calls it over outbound HTTPS; the web service does not need inbound access to the
Minecraft server. Premium verification runs **inside the plugin**, not a standalone Node service.

| Location | Responsibility |
| --- | --- |
| `server/src/index.ts` | OAuth callback, HMAC-protected plugin API, limbo handoff, premium linking and returning login. |
| `server/src/lib/ft42.ts` | 42 API requests, eligibility, selected title extraction. |
| `server/src/lib/uuid.ts` | Canonical 42-derived Minecraft UUID encoding; identity compatibility boundary. |
| `server/src/lib/{hmac,token,rate,bans,premium,web}.ts` | Signing, token hashes, rate limits, bans, account links, browser sessions. |
| `server/src/lib/{mojang,mineskin}.ts` | Signed skin retrieval and upload validation/signing. |
| `server/src/me.ts`, `server/src/admin.ts` | Self-service profile and deletion; authenticated administration. |
| `server/src/lib/{audit,account}.ts` | Hash-chained login audit, retention redaction; account deletion/anonymization. |
| `server/src/pages.ts` | Public index and privacy policy (`/privacidade` pt-BR, `/privacy` en). |
| `server/cloudflare.config.ts` | Worker entry point, D1 binding, text variables, secret declarations, custom domain. |
| `server/migrations/` | Ordered SQL schema changes. |
| `plugin/src/main/java/dev/login42/plugin/` | Startup, authenticated identity rewrite, HTTP client, limbo, guest isolation, bans, chat, skin refresh. |
| `plugin/src/main/java/dev/login42/plugin/premium/` | Netty injection, protocol framing, RSA/AES handshake, Mojang verification, transfer back. |
| `plugin/src/main/resources/` | Paper plugin descriptor and **default** configuration, not the live configuration. |

## Behavioral requirements

### Identity and eligibility

- The immutable 42 numeric ID is the identity. `ftIdToUuid` produces an RFC 9562 v8 UUID with
  fixed high bits and the 42 ID embedded in the low bits. **Do not change this mapping**: world
  saves, inventories, bans, and LuckPerms data depend on it.
- In-game names come from the 42 login, with hyphens mapped to underscores. Ignore the client's
  chosen name. Reject unsupported names and collisions rather than merging identities.
- Default eligibility is `kind === "student"`, `active? === true`, and `alumni? !== true`.
  Staff/admin access follows `ALLOW_STAFF`, currently false.
- Do not authenticate by name, claimed UUID, IP, or campus NAT address. There is no admin-name
  bypass. A banned account's name must not prevent a different 42 account from authenticating.
- Authentication must fail closed when credentials are missing or verification is unavailable.
  A missing plugin HMAC secret denies all logins. Optional chat failures must not stop the login
  gate from registering.

### Browser login and limbo

1. `LoginListener` reads `login42:session` during async pre-login and calls `/api/v1/join-check`.
2. A valid handoff token is consumed; the plugin replaces the profile with the canonical UUID/name
   and signed skin, before saved player data loads. The player returns to their saved location.
3. Otherwise, assign a random guest UUID/name (`g-xxxxxxxx`) and place the player in the void
   `login42_limbo` world. Never use their claimed identity for a guest.
4. Guests are isolated from entities, tab lists, chat, commands, interaction, and normal announcements.
   Preserve guest caps, rate limits, hidden server-list counts, and guest player-data cleanup.
5. The browser link performs 42 OAuth. The plugin polls for the result, stores the one-use token
   in the client, and transfers back. OAuth state and handoff delivery are single-use.

`/link/:code` and `/me/login` are stable sign-in pages. Their Continue button opens
`/link/:code/authorize` or `/me/authorize` in a separate tab; each click issues a fresh OAuth state
and complete `response_type=code` URL. Keep this recovery flow: an error reported on 2026-10-24
landed at the bare 42 authorize endpoint without its required query parameters. A later callback
reported consumed/expired state. Do not replay an authorization code or bypass state validation;
retry the first-party sign-in page, or rejoin Minecraft when the game link has expired/been claimed.
42 token/profile verification requests are time-limited. VPN/IP changes alone do not invalidate
OAuth state: this application does not bind browser state to the player's IP.

**Vanilla Minecraft cookies survive transfers, not manual reconnects.** Clients without Microsoft
authentication intentionally use browser sign-in on reconnect. Do not describe these cookies as
persistent sessions, introduce name/IP-based remembered logins, or require a client mod: the user
chose to retain the browser flow for those clients.

### Premium linking and automatic login

- `/premium` is available after 42 sign-in. It obtains a one-time linking token, stores it as
  `login42:premium`, and transfers to the plugin's verifier host. The real online-mode exchange
  uses RSA, AES/CFB8, and Mojang `hasJoined` to prove ownership before linking to the 42 account.
- **An already-linked player with a real Minecraft premium session must not need another 42
  browser login, including on the normal server address.** Preserve this requirement.
- On a new normal connection, `PremiumGate` inspects the Login Start UUID against cached linked
  account hints. This selects the authentication path only; it is not proof. The client must
  complete Mojang authentication, then `/api/v1/premium/login` checks the saved link, current
  42 eligibility, and bans before issuing a fresh transfer token.
- Hints come from HMAC-protected `/api/v1/premium/accounts`, refresh every 30 seconds, and update
  immediately after in-game linking. A stale hint must never grant access.
- **Do not intercept return transfers (handshake intent 3) on the normal host.** They carry the
  one-use session cookie; intercepting them again causes a verification/transfer loop.
- Explicit `verify.*` hosts perform premium verification. Unlinked accounts get a code for `/me`.
  `premium.browser-host-prefix`, default `offline.`, explicitly selects browser login instead.
- `premium_accounts` stores ownership independently from `skin_source`. Uploading/resetting a
  skin must not unlink an account. Explicit premium unlink removes the ownership link and
  outstanding session/linking tokens. One Mojang account cannot belong to two 42 accounts.
- Token issuance must still reject a ban or unlink occurring during the external 42 lookup.
  Preserve the conditional SQL insert and transaction boundaries used for linking.
- Netty injection uses reflection on server internals. Check actual Paper/protocol documentation
  when changing it. Preserve packet buffering, fragmented inputs, limits, encryption, and
  byte-for-byte passthrough for unhandled connections. Injection failure leaves browser login
  available; never turn it into an authentication bypass.

### LuckPerms, chat, and titles

- `LoginListener` authenticates and rewrites identity at **LOWEST** pre-login priority. LuckPerms
  loads users at **LOW**. Reversing this order loads permissions for the wrong UUID or denies login.
- LuckPerms is an optional Paper dependency loaded before Login42 with classpath access. Its
  absence disables customization, not authentication. Do not bundle the LuckPerms implementation.
- `/chatcolor` (`/chatcolour`) accepts the 16 named colors, `#RRGGBB`, or `reset`. Each signed-in
  player may change only their own metadata key, `login42-chat-color`, under their canonical UUID.
  Save asynchronously through LuckPerms; use cached metadata in the async chat renderer.
- **Color only the chat name. Never recolor message content.** Preserve existing message formatting.
  The title hover and bold decoration must also remain scoped to the name.
- Use the **selected** Intra title: match `titles_users.selected === true` and `title_id` to
  `titles.id`, then replace `%login` with the 42 login. Do not pick the first earned title.
  For example, a selected `%login, Writer's soul` for login `jdoe` reads `jdoe, Writer's soul`.
- Refresh titles on OAuth and returning premium login. No selected title means no title hover
  and no title-based bold. Clear old titles when selection is removed.
- Treat titles and chat as literal Adventure components, not MiniMessage/legacy markup. Keep
  title length/control-character handling and do not leak guest identity or chat to other guests.

### Bans and skins

- `BanSync`/`BanReconciler` reconcile in-game and service bans/pardons in both directions. A web
  ban kicks the player; a pardon clears the local ban. Ban enforcement follows the 42 ID.
- Admin routes under `/admin/v1`: `POST /bans` with `{login, reason}`, `DELETE /bans/:login`,
  `GET /users/:login`, `DELETE /users/:login`, `GET /audit?limit=...`, `GET /logins?...` and
  `GET /logins/verify`. Admin bans can resolve a 42 login that has never joined. Pardon a banned
  account before attempting user deletion.

### Login audit, privacy, and deletion

- `login_audit` (migration 0008) records authentications for abuse investigations under legitimate
  interest: `game_login` (token consumed at join-check), `game_login_banned`, `token_reuse`,
  `oauth_game`/`oauth_web`/`oauth_denied` (browser IP from `CF-Connecting-IP`, user agent),
  `premium_login`/`premium_login_denied`/`premium_proof`/`premium_link`, and `account_deleted`.
  Rows carry 42 login, canonical `mc_name`/UUID, client-claimed name/UUID (unverified), Mojang
  identity, game TCP peer IP reported by the plugin, virtual host, and the **SHA-256 of the one-use
  token** (correlates issuance to use; never store the token itself).
- **No record, no access.** `game_login`, `premium_login`, `premium_link` token issuance and browser
  sign-in fail closed when the audit write fails; denials and web-side linking are best effort.
  Token consumption at join-check is conditional (`used_at IS NULL`), so a token admits one connection.
- Each row's `hash = SHA-256(prev_hash + "\n" + canonical JSON of FIELDS)`, `UNIQUE(prev_hash)` keeps the
  chain linear under concurrency (writers retry). Append new columns to the **end** of `FIELDS` only.
  Triggers forbid DELETE and any UPDATE except a complete redaction. The plugin logs
  `Login audit #<id> <hash>` per entry in the game server log as an external anchor; compare it with
  `GET /admin/v1/logins/verify` (`head`) when presenting evidence.
- Account deletion (`POST /me/delete`, `DELETE /admin/v1/users/:login`, both `lib/account.ts`)
  deletes profile/link/skin/session/token rows, anonymizes `audit_log`, and schedules that account's
  earlier `login_audit` rows (by 42 ID and the linked Mojang UUID) for redaction 183 days later in
  `login_audit_erasure`. Redaction runs opportunistically in the join-check limbo purge batch.
  Banned accounts cannot be deleted. Game-server data (world, LuckPerms, CoreProtect, server logs)
  is not touched by the web service.
- The privacy policy states retention promises; keep `/privacidade` and `/privacy` consistent with
  the code. `PRIVACY_CONTACT` (currently `42craft@zoe.dev.br`) is the published LGPD contact.
  The 6-month erasure applies only to `login_audit`; game-server logs and CoreProtect data are kept
  while needed for moderation and operation, as the policy states.
- Signed textures are required. Uploaded PNGs are validated and signed through MineSkin as
  **unlisted**; do not silently change visibility or assume paid private uploads are available.
- Mojang profile requests from Cloudflare Workers have returned HTTP 403. The game server fetches
  fresh signed premium textures, caches briefly, and falls back to the verified stored snapshot.
  Do not regress to requiring `/premium` every time a player changes their Mojang skin.
- `SkinSync` polls the HMAC-protected `POST /api/v1/skins` endpoint for signed-in online UUIDs in
  batches of at most 100. It reads current upload/default/Mojang selection without external calls
  from the Worker, then fetches Mojang textures asynchronously on the game server. Polling defaults
  to 60 seconds (`skins.poll-seconds`, minimum 60); shared Mojang success cache lasts 60 seconds.
  Visible updates normally take 1–2 minutes plus any Mojang propagation delay.
- Apply online changes with Paper's `Player.setPlayerProfile` on the main thread, preserving the
  canonical UUID/name and other properties. Never manually unhide guests to refresh a skin.
  Compare decoded texture content, not timestamps/signatures, to avoid needless client refreshes.
  Network/unsigned-data failures leave the current online skin alone; only an explicit default
  selection clears it. Ignore results for players who disconnected or rejoined in the meantime.

## Toolchain and local development

- Plugin: Java 25 toolchain, installed Gradle (no wrapper), Paper API
  `26.3.build.214-stable`, Netty `4.2.16.Final`, LuckPerms API `5.4`, JUnit 5.
  Output: `plugin/build/libs/login42.jar`.
- Service: Node 24 has been used successfully; the tests need a Node runtime with `node:sqlite`.
  TypeScript, Hono, Vite, and Cloudflare's **`cf` CLI**, not a Wrangler configuration. Use the
  checked-in lockfile; do not replace this setup casually with a different development server.
- Install service dependencies with `npm ci` in `server/`. If absent, copy `.dev.vars.example`
  to `.dev.vars` and configure local secrets without overwriting existing values.
- `npm run dev` in `server/` starts `cf dev` at `http://127.0.0.1:5173`.
- `npm run build` builds the Worker. `npm run typecheck` generates Worker types and runs TypeScript;
  `./node_modules/.bin/tsc --noEmit` checks when generated types already exist.
- `gradle test build` in `plugin/` tests and builds the plugin.

### Database migrations

Apply numbered SQL files in order. For existing databases, inspect migration history/schema and
apply **only missing migrations**; these files are not generally safe to replay.

| Migration | Purpose |
| --- | --- |
| `0001_init.sql` | Initial identities, bans, legacy sessions, skin source, audit. |
| `0002_limbo_tokens.sql` | Replace legacy sessions/link codes with one-use tokens and limbo codes. |
| `0003_rate_limits_admin.sql` | Rate limits and removal of claimed names from limbo codes. |
| `0004_web_skins.sql` | Web sessions, premium proofs, Mojang texture cache. |
| `0005_premium_tokens.sql` | One-time in-game premium linking tokens. |
| `0006_special_title.sql` | Selected Intra title on users. |
| `0007_premium_accounts.sql` | Independent Mojang ownership links; backfill existing verified skins. |
| `0008_login_audit.sql` | Hash-chained, append-only login audit; erasure schedule for deleted accounts. |

The local D1 used by `cf dev` is not necessarily the database state written by
`cf d1 migrations apply ... --local`. Use the running dev explorer:

1. `GET /cdn-cgi/local/explorer/api/d1/database` to discover its actual UUID.
2. `POST /cdn-cgi/local/explorer/api/d1/database/<uuid>/raw` with JSON
   `{"batch":[{"sql":"<migration SQL>"}]}` for the missing migrations.
3. Restart the dev server if necessary and verify the schema in that same database.

For production, migrate the actual D1 binding before deploying code that references new columns
or tables. Preserve existing identities, account links, bans, and player data. Do not run the local
integration suite or its cleanup SQL against production.

## Verification

From `server/`, run `./node_modules/.bin/vitest run` and TypeScript checking. The integration suite
requires a configured `.dev.vars` **even at import time**, and a running, migrated local `cf dev`.
It skips integration tests if the dev server is absent; report skipped tests instead of calling
that a full pass. `premium-login.test.ts` uses the real schema in in-memory SQLite and mocks only
the external 42 API. Keep fallback tests deterministic rather than waiting for live Mojang failure.

From `plugin/`, run `gradle test build`. Tests include HMAC compatibility, ban reconciliation,
chat components, texture refresh, and a fake Minecraft client exercising RSA/AES, cookie handling,
normal-address premium login, spoofed hints, fragmented packets, and transfer-loop prevention.
Last full checks on 2026-10-24 passed **59 service tests (including 19 integration) and 39 plugin
tests**; these are historical
counts, not a substitute for running relevant checks after code changes.

For authentication/protocol changes, also verify with a real client when available:

- Browser path: guest isolation → 42 OAuth → cookie transfer → canonical identity and saved location.
- Linked premium: fresh normal-address connection → Mojang proof → game, without browser or limbo.
- No repeated transfer loop; offline/unlinked clients can still use the browser path.
- Ban/pardon enforcement, token replay denial, and fail-closed behavior.
- For chat changes: named/RGB color and reset, persistence after reconnect/restart, name-only color,
  selected title hover/bold, and no formatting on untitled players.

Normal-address automatic premium login was observed on production after the last restart on
2026-10-23: `Premium automatic login ready ...`, then `Mojang-verified returning login ...`,
canonical UUID, and entry into the overworld without a limbo login. Title component behavior is
covered by tests; no live visual hover screenshot was captured for a titled account.

## Configuration and deployment

Required server properties: `online-mode=false`, `accepts-transfers=true`, `white-list=false`.
Paper 26.x may generate a whitelist enabled by default, which blocks the intended login flow.
Declared client support starts at 1.20.5 because of cookies/transfers; the real-client verification
has been on 26.3. Check packet layouts rather than assuming all versions behave identically.

Install OfflineEncryptor separately for offline-mode protocol encryption; it is GPLv3 and must
not be bundled into Login42. It protects against passive sniffing, not active on-path interception.
Install LuckPerms separately for chat preferences and preserve `plugins/LuckPerms/` in backups.

Worker secrets: `FT_CLIENT_ID`, `FT_CLIENT_SECRET`, `PLUGIN_HMAC_SECRET`, `ADMIN_TOKEN`,
`MINESKIN_API_KEY` (optional for uploads). Text settings live in `server/cloudflare.config.ts`:
`PUBLIC_URL`, `TOKEN_TTL_SECONDS`, `ALLOW_STAFF`, `LIMBO_PER_MINUTE`, `VERIFIER_ADDRESS`, `PRIVACY_CONTACT`.
Register `<PUBLIC_URL>/auth/callback` in the 42 OAuth application.

The live `plugins/Login42/config.yml` is independent of the bundled defaults. Preserve it when
uploading a jar: `saveDefaultConfig()` does not merge new settings into existing configurations.
The HMAC secret must match the Worker. Check premium routing explicitly instead of relying on
derived hostnames.

### Existing deployment (verify live state before operating)

- Web/profile: `https://42craft.zoe.dev.br`; Worker `login42`, D1 `42login`.
  D1 ID: `6c0a683e-70da-4aa8-b53b-b0790fa884bd`.
- Game: Pelican server `42craft`, short ID `c754b94b`; Purpur 26.3. LuckPerms 5.5.88 was installed.
- Minecraft DNS: `_minecraft._tcp.42craft.zoe.dev.br` SRV `0 5 24242 42.g.zoe.dev.br`.
  `*.g.zoe.dev.br` resolves to the game host. The public `42craft` hostname serves the Worker too.
- Live verifier settings: `premium.verify-address: "verify.g.zoe.dev.br:24242"` and
  `premium.return-address: "42.g.zoe.dev.br:24242"`.
  **`verify.42craft.zoe.dev.br` is not covered by the game wildcard.** This caused failed `/premium`
  transfers before explicit routing was configured.
- Local production secrets file: `~/.config/login42/prod.env`, mode 600, outside the repository.
  When deployment is in scope: from `server/`, run
  `./node_modules/.bin/cf deploy --secrets-file ~/.config/login42/prod.env`.
- Upload the binary `plugin/build/libs/login42.jar` to `/plugins/login42.jar`; do not leave another
  loadable copy in the top-level plugins directory. `dist/` contains ignored distribution copies
  and may include an older fallback jar; always build from source for a new deployment.
- Use a graceful stop/restart for jar updates. Check uploaded bytes/hash, startup logs, plugin
  enablement, automatic-login hint readiness, and a real reconnect after relevant deployments.
  Keep rollback copies outside plugin discovery paths. Do not replace live config or secret files.

For local/documentation tasks, no production mutation or restart is needed. For authorized live
work, prefer the connected Pelican, Cloudflare, and mcpfabric tools. Pelican's current MCP file
writer handles text, not jars: use its binary upload API or the panel/SFTP when necessary. Never
pass binary jar contents through the text writer. Cloudflare D1 operations should target the
configured database, not a similarly named local instance.

The game bridge is client-side mcpfabric. Call `get_status` first, then use `get_screen`/`join_world`
for connection state. `join_world` is only valid from menus; the user may already have rejoined.
An unfocused client can reopen its pause menu immediately, so a closed-menu command is not visual
proof. Use logs/components for the claims they actually establish and screenshots for rendering.
Clean up only the local dev processes/browser tabs started for your task; leave production running.

## Security and maintenance discipline

- `/api/v1/*` uses HMAC-SHA256 of `timestamp.METHOD.path.body`, a 13-digit millisecond timestamp,
  and a 30-second skew window. Keep Java `Signer` and TypeScript signing compatible. Sign the exact
  transmitted body/path. Admin API `/admin/v1` requires `Authorization: Bearer <ADMIN_TOKEN>`;
  keep it restricted at the network/Cloudflare layer where appropriate.
- Session tokens have 256 bits of randomness, are hashed at rest, expire after 120 seconds by
  default, and are single-use. Replaying a consumed token revokes that user's tokens. Browser
  sessions use HttpOnly cookies and CSRF checks; preserve those checks for profile mutations.
- Never print, commit, embed in docs, or paste secrets into visible commands/tool arguments.
  `.dev.vars`, production environment files, live plugin configs, and MCP launchers can contain
  credentials. Redact before displaying configuration/API results; use existing configured secret
  sources rather than copying historical transcript values. Rotation is a separate operation
  requiring all relevant services to be updated consistently.
- Read `.gitignore` before adding artifacts. Do not commit dependencies, build output, local
  Cloudflare state, credential files, or runtime databases. Inspect actual Git availability before
  assuming repository status/history is accessible in a sandboxed checkout.
- Use parameterized SQL, preserve foreign-key cleanup and unlink semantics, and add numbered
  migrations instead of rewriting applied history. Test account conflicts and auth races.
- Verify current official API/Paper/LuckPerms documentation for new integration work; do not guess
  endpoints, event order, protocol fields, or permission behavior from old transcripts.
- Eligibility edge cases (real staff/alumni/piscine accounts) still need broader real-account
  validation. Active accounts' login records have no time limit.
  These are known limitations, not evidence that checks can be bypassed.
- Keep changes focused on the requested work. Report actual checks, skips, production effects,
  and remaining limitations. Update this handoff when architecture or operational behavior changes.
