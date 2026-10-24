package dev.login42.plugin;

import com.destroystokyo.paper.profile.ProfileProperty;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import com.google.gson.JsonParser;
import org.bukkit.entity.Player;

/** Polls off-thread, then applies changed signed textures on the server thread without reconnecting. */
final class SkinSync {
    private final Login42Plugin plugin;
    private final ApiClient api;
    private final Limbo limbo;
    private final MojangProfiles profiles;
    private final AtomicBoolean running = new AtomicBoolean();

    SkinSync(Login42Plugin plugin, ApiClient api, Limbo limbo, MojangProfiles profiles) {
        this.plugin = plugin; this.api = api; this.limbo = limbo; this.profiles = profiles;
    }

    void start() {
        long seconds = Math.max(60, plugin.getConfig().getLong("skins.poll-seconds", 60));
        plugin.getServer().getScheduler().runTaskTimer(plugin, this::poll, 20L, seconds * 20L);
        plugin.getLogger().info("Live skin updates enabled (every " + seconds + " seconds)");
    }

    private void poll() {
        if (!running.compareAndSet(false, true)) return;
        Map<UUID, Player> players = new java.util.HashMap<>();
        for (Player p : plugin.getServer().getOnlinePlayers()) if (!limbo.isGuest(p)) players.put(p.getUniqueId(), p);
        if (players.isEmpty()) { running.set(false); return; }
        plugin.getServer().getScheduler().runTaskAsynchronously(plugin, () -> {
            try {
                List<String> ids = players.keySet().stream().map(UUID::toString).toList();
                for (int offset = 0; offset < ids.size(); offset += 100) {
                    for (ApiClient.SkinState state : api.skinStates(ids.subList(offset, Math.min(offset + 100, ids.size())))) {
                        UUID id = UUID.fromString(state.uuid());
                        Player target = players.get(id);
                        if (target == null) continue;
                        ProfileProperty desired = resolve(state, profiles, plugin.getConfig().getBoolean("premium.refresh-skin", true));
                        // Unavailable/unsigned upstream data must not clear or revert a live player's skin.
                        if (desired == null && !"default".equals(state.kind())) continue;
                        if (!plugin.isEnabled()) return;
                        plugin.getServer().getScheduler().runTask(plugin, () -> apply(target, desired));
                    }
                }
            } catch (Exception e) {
                if (e instanceof InterruptedException) Thread.currentThread().interrupt();
                plugin.getLogger().warning("Live skin refresh failed: " + e);
            } finally {
                running.set(false);
            }
        });
    }

    static ProfileProperty resolve(ApiClient.SkinState state, MojangProfiles profiles, boolean refreshMojang) {
        if ("mojang".equals(state.kind())) {
            if (!refreshMojang || state.mojangUuid() == null) return null;
            return profiles.fresh(state.mojangUuid()).map(t -> new ProfileProperty("textures", t.value(), t.signature())).orElse(null);
        }
        if ("upload".equals(state.kind()) && state.value() != null && !state.value().isBlank() && state.signature() != null && !state.signature().isBlank()) return new ProfileProperty("textures", state.value(), state.signature());
        return null;
    }

    private void apply(Player target, ProfileProperty desired) {
        // Ignore work for a disconnected/replaced connection, and never expose limbo guests.
        if (plugin.getServer().getPlayer(target.getUniqueId()) != target || limbo.isGuest(target)) return;
        var profile = target.getPlayerProfile();
        ProfileProperty current = profile.getProperties().stream().filter(p -> p.getName().equals("textures")).findFirst().orElse(null);
        if (fingerprint(current).equals(fingerprint(desired))) return;
        profile.removeProperty("textures");
        if (desired != null) profile.setProperty(desired);
        // Paper re-registers the profile for visible clients; preserve its canonical UUID/name and other properties.
        target.setPlayerProfile(profile);
        plugin.getLogger().info(target.getName() + ": updated skin while online");
    }

    // Mojang changes timestamps/signatures on unchanged textures. Compare visual content only.
    static com.google.gson.JsonElement fingerprint(ProfileProperty property) {
        if (property == null) return com.google.gson.JsonNull.INSTANCE;
        try {
            var json = JsonParser.parseString(new String(Base64.getDecoder().decode(property.getValue()), StandardCharsets.UTF_8)).getAsJsonObject();
            var textures = json.getAsJsonObject("textures");
            if (textures != null) return textures;
        } catch (RuntimeException ignored) { }
        return new com.google.gson.JsonPrimitive(property.getValue());
    }
}
