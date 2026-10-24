package dev.login42.plugin;

import com.destroystokyo.paper.profile.PlayerProfile;
import com.destroystokyo.paper.profile.ProfileProperty;
import io.papermc.paper.connection.PlayerLoginConnection;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import net.kyori.adventure.text.Component;
import org.bukkit.Bukkit;
import org.bukkit.configuration.file.FileConfiguration;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.AsyncPlayerPreLoginEvent;
import org.bukkit.event.player.AsyncPlayerPreLoginEvent.Result;

final class LoginListener implements Listener {
    private final Login42Plugin plugin;
    private final ApiClient api;
    private final Limbo limbo;
    private final MojangProfiles profiles;
    private final java.util.function.BiConsumer<UUID, String> titles;

    LoginListener(Login42Plugin plugin, ApiClient api, Limbo limbo, java.util.function.BiConsumer<UUID, String> titles, MojangProfiles profiles) {
        this.plugin = plugin;
        this.api = api;
        this.limbo = limbo;
        this.titles = titles;
        this.profiles = profiles;
    }

    // Async, so blocking on the cookie round-trip and the web service is fine. Fail closed on any error.
    // LuckPerms loads the player's data at LOW; it must see the canonical identity already.
    @EventHandler(priority = EventPriority.LOWEST)
    public void onPreLogin(AsyncPlayerPreLoginEvent event) {
        if (event.getLoginResult() != Result.ALLOWED) return;
        FileConfiguration cfg = plugin.getConfig();
        try {
            PlayerLoginConnection conn = event.getConnection();
            String token = readCookie(conn);
            String ip = event.getAddress().getHostAddress();
            InetSocketAddress vh = conn.getVirtualHost();
            String host = vh != null ? vh.getHostString() + ":" + vh.getPort() : "";
            ApiClient.JoinResult r = api.joinCheck(event.getName(), event.getUniqueId().toString(), token, ip, host);
            switch (r.status()) {
                case "allow" -> {
                    // The client's claimed name/UUID are replaced by the 42-bound identity.
                    UUID id = UUID.fromString(r.uuid());
                    PlayerProfile real = Bukkit.createProfileExact(id, r.name());
                    // Mojang-signed textures only; with none the client shows its default skin for this UUID.
                    if (r.skin() != null) {
                        String value = r.skin().value();
                        String signature = r.skin().signature();
                        String source = r.skin().mojangUuid() == null ? "uploaded skin" : "stored Mojang snapshot";
                        // A linked Mojang account: prefer fresh textures fetched from this machine (the web service cannot).
                        if (r.skin().mojangUuid() != null && plugin.getConfig().getBoolean("premium.refresh-skin", true)) {
                            var fresh = profiles.fresh(r.skin().mojangUuid());
                            if (fresh.isPresent()) {
                                value = fresh.get().value();
                                signature = fresh.get().signature();
                                source = "fresh from Mojang";
                            }
                        }
                        real.setProperty(new ProfileProperty("textures", value, signature));
                        plugin.getLogger().info(r.name() + ": applied signed skin (" + source + ")");
                    }
                    event.setPlayerProfile(real);
                    titles.accept(id, r.specialTitle());
                    // Anchors the web service's hash-chained login record in this server's own log.
                    plugin.getLogger().info("Login audit #" + r.auditId() + " " + r.auditHash() + ": " + r.name() + " (" + id + ") from " + ip + " via " + host);
                }
                case "limbo" -> {
                    if (!limbo.hasRoom(ip)) {
                        event.disallow(Result.KICK_FULL, Component.text(cfg.getString("messages.busy", "Too many people are signing in. Try again shortly.")));
                        return;
                    }
                    // Unauthenticated: a throwaway identity, never the claimed name, so nobody can
                    // collide with or kick a real player by typing their name.
                    UUID gid = UUID.randomUUID();
                    PlayerProfile guest = Bukkit.createProfileExact(gid, "g-" + gid.toString().substring(0, 8));
                    event.setPlayerProfile(guest);
                    limbo.guests.put(gid, new Guest(r.code(), r.url(), transferHost(conn), transferPort(conn), ip));
                }
                case "rate_limited" -> event.disallow(Result.KICK_OTHER, Component.text(cfg.getString("messages.rate-limited", "Too many attempts. Wait a minute and try again.")));
                case "banned" -> event.disallow(Result.KICK_BANNED, Component.text(
                        cfg.getString("messages.banned", "You are banned.") + (r.reason() == null || r.reason().isBlank() ? "" : "\n" + r.reason())));
                default -> throw new IllegalStateException("unexpected status " + r.status());
            }
        } catch (Exception e) {
            if (e instanceof InterruptedException) Thread.currentThread().interrupt();
            plugin.getLogger().warning("join-check failed for " + event.getName() + ": " + e);
            event.disallow(Result.KICK_OTHER, Component.text(cfg.getString("messages.unreachable", "Login service unavailable.")));
        }
    }

    // A client with no cookie (or that never answers) simply goes to limbo.
    private String readCookie(PlayerLoginConnection conn) {
        try {
            byte[] raw = conn.retrieveCookie(Limbo.COOKIE).get(3, TimeUnit.SECONDS);
            return raw == null ? null : new String(raw, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }

    // Reconnect the client to the address it used, unless config overrides it.
    private String transferHost(PlayerLoginConnection conn) {
        String configured = plugin.getConfig().getString("transfer.host", "");
        if (!configured.isBlank()) return configured;
        InetSocketAddress vh = conn.getVirtualHost();
        return vh != null ? vh.getHostString() : "localhost";
    }

    private int transferPort(PlayerLoginConnection conn) {
        int configured = plugin.getConfig().getInt("transfer.port", 0);
        if (configured > 0) return configured;
        InetSocketAddress vh = conn.getVirtualHost();
        return vh != null ? vh.getPort() : Bukkit.getPort();
    }
}
