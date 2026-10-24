package dev.login42.plugin;

import net.kyori.adventure.text.Component;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.AsyncPlayerPreLoginEvent;
import org.bukkit.plugin.java.JavaPlugin;

public final class Login42Plugin extends JavaPlugin {
    @Override
    public void onEnable() {
        saveDefaultConfig();
        String secret = getConfig().getString("hmac-secret", "");
        if (secret.isBlank()) {
            // Fail closed: a misconfigured gate must not become an open server.
            getLogger().severe("hmac-secret is not set in config.yml; denying ALL logins until it is.");
            getServer().getPluginManager().registerEvents(new Listener() {
                @EventHandler(priority = EventPriority.HIGHEST)
                public void onPreLogin(AsyncPlayerPreLoginEvent e) {
                    e.disallow(AsyncPlayerPreLoginEvent.Result.KICK_OTHER, Component.text("Login service is not configured."));
                }
            }, this);
            return;
        }
        ApiClient api = new ApiClient(getConfig().getString("api-url"), secret, getConfig().getInt("timeout-seconds", 5));
        Limbo limbo = new Limbo(this, api);
        limbo.createWorld();
        limbo.startSweeper();
        java.util.function.BiConsumer<java.util.UUID, String> titles = (id, title) -> {};
        if (getServer().getPluginManager().isPluginEnabled("LuckPerms")) {
            try {
                ChatFeatures chat = new ChatFeatures(this, limbo);
                chat.register();
                titles = chat::setTitle;
            } catch (RuntimeException | LinkageError e) {
                // A chat integration failure must never prevent the authentication gate from registering.
                getLogger().severe("Chat integration unavailable; authentication remains enforced: " + e);
            }
        } else {
            getLogger().warning("LuckPerms is not installed; chat colors and title formatting are unavailable.");
        }
        MojangProfiles profiles = new MojangProfiles(getConfig().getString("premium.profile-url", "https://sessionserver.mojang.com/session/minecraft/profile/"));
        getServer().getPluginManager().registerEvents(new LoginListener(this, api, limbo, titles, profiles), this);
        getServer().getPluginManager().registerEvents(new GuestListener(this, limbo), this);
        new SkinSync(this, api, limbo, profiles).start();
        if (getConfig().getBoolean("premium.enabled", true)) {
            dev.login42.plugin.premium.PremiumVerifier.install(this, api,
                    getConfig().getString("premium.host-prefix", "verify."),
                    getConfig().getString("premium.session-url", "https://sessionserver.mojang.com/session/minecraft/hasJoined"),
                    getConfig().getString("api-url") + "/me",
                    getConfig().getString("premium.return-address", ""),
                    runnable -> getServer().getScheduler().runTaskAsynchronously(this, runnable));
        }
        new BanSync(this, api).start(getConfig().getLong("ban-poll-seconds", 10) * 20L);
    }
}
