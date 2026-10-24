# login42

Minecraft access for current **42 students**, with identities and bans tied to their 42 accounts.

Players sign in through 42 Intra before entering the world. The Paper plugin works with a separate
web service (Bun, Hono and SQLite, deployed as Podman Quadlets), so the game server only needs
outbound HTTPS to the login service. Minecraft runs in offline mode, allowing clients without
Microsoft authentication.

## What it does

- **42 authentication:** checks student eligibility and keeps unauthenticated players in an isolated
  limbo until sign-in finishes.
- **Stable identities:** uses the 42 login as the player name (hyphens become underscores) and derives
  a permanent Minecraft UUID from the numeric 42 ID. Player progress follows the account.
- **Automatic premium login:** after linking a Mojang/Microsoft account with `/premium`, future
  connections to the normal server address verify ownership with Mojang and enter without another
  42 browser login. Eligibility and bans are still checked in the background.
- **Account-based bans:** synchronizes bans and pardons between Minecraft and the web service.
- **Skins:** supports signed skin uploads and verified Mojang skins, independently of the saved
  premium account link. Uploads, resets, and Mojang skin changes refresh while players are online,
  normally within 1–2 minutes (Mojang propagation can add a delay).
- **Abuse auditing and privacy:** every sign-in is recorded in a tamper-evident, hash-chained log
  (time, IP, Minecraft profile, and a hash of the one-use login token). The site publishes an LGPD
  privacy policy ([`/privacidade`](https://42craft.zoe.dev.br/privacidade),
  [`/privacy`](https://42craft.zoe.dev.br/privacy)), and players can delete their own account.
- **Personalized chat names:** LuckPerms stores each player's name color under their 42 identity.
  A selected Intra title appears on name hover and makes the name bold. Message text keeps its
  normal formatting.

Clients without Microsoft authentication continue to use browser sign-in on reconnect. Minecraft
cookies are single-use transfer credentials, not persistent login cookies.

## Player commands

| Command | Purpose |
| --- | --- |
| `/premium` | Link a Mojang/Microsoft account after signing in with 42. |
| `/chatcolor aqua` | Choose a named color for your chat name. |
| `/chatcolor #55CCAA` | Choose an RGB color for your chat name. |
| `/chatcolor reset` | Restore the default name color. |

The web profile provides skin upload, premium unlinking, and account deletion.

## Project layout

| Directory | Component |
| --- | --- |
| [`plugin/`](plugin/) | Java 25 plugin for Paper/Purpur 26.3: login gate, limbo, premium verification, bans, and chat. |
| [`server/`](server/) | TypeScript/Hono service on Bun with SQLite: 42 OAuth, identity, tokens, login audit, profiles, and admin API. |
| [`deploy/vps/`](deploy/vps/) | Podman Quadlet units that build the service from this repository and run it with nightly backups. |

The game server uses [OfflineEncryptor](https://github.com/Lumine1909/OfflineEncryptor) for offline-mode
protocol encryption and [LuckPerms](https://luckperms.net/) for persistent chat preferences.

For development, configuration, deployment, security constraints, and verification, read
[`AGENTS.md`](AGENTS.md).
