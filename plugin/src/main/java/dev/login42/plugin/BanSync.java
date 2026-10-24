package dev.login42.plugin;

import com.destroystokyo.paper.profile.PlayerProfile;
import io.papermc.paper.ban.BanListType;
import java.time.Instant;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import net.kyori.adventure.text.Component;
import org.bukkit.BanEntry;
import org.bukkit.Bukkit;
import org.bukkit.ban.ProfileBanList;
import org.bukkit.entity.Player;

/**
 * Keeps the profile ban list and the web service's bans in step, in both directions.
 * Paper has no ban-list change event, so every period we snapshot the local list on the main thread,
 * reconcile with the server on an async thread (see {@link BanReconciler}), then apply local changes
 * back on the main thread. Bans made on the web therefore kick the player in game.
 */
final class BanSync {
    private final Login42Plugin plugin;
    private final ApiClient api;
    private Set<UUID> lastLocal = null;
    private Set<UUID> lastServer = null;
    private boolean busy = false;

    BanSync(Login42Plugin plugin, ApiClient api) {
        this.plugin = plugin;
        this.api = api;
    }

    void start(long periodTicks) {
        Bukkit.getScheduler().runTaskTimer(plugin, this::tick, 20L, periodTicks);
    }

    private void tick() {
        if (busy) return;
        busy = true;
        Map<UUID, String> reasons = new HashMap<>();
        ProfileBanList list = Bukkit.getBanList(BanListType.PROFILE);
        for (BanEntry<PlayerProfile> e : list.<BanEntry<PlayerProfile>>getEntries()) {
            UUID id = e.getBanTarget().getId();
            if (id != null) reasons.put(id, e.getReason());
        }
        Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> reconcile(reasons));
    }

    private void reconcile(Map<UUID, String> localReasons) {
        try {
            Map<UUID, ApiClient.ServerBan> server = new HashMap<>();
            for (ApiClient.ServerBan b : api.listBans()) server.put(UUID.fromString(b.uuid()), b);
            Set<UUID> local = new HashSet<>(localReasons.keySet());
            Set<UUID> serverIds = new HashSet<>(server.keySet());

            BanReconciler.Plan plan = BanReconciler.plan(local, serverIds, lastLocal, lastServer);
            for (UUID u : plan.pushBans()) api.ban(u.toString(), localReasons.get(u), "Server");
            for (UUID u : plan.pushPardons()) api.pardon(u.toString(), "Server");

            Set<UUID> newLocal = BanReconciler.localAfter(local, plan);
            Set<UUID> newServer = BanReconciler.serverAfter(serverIds, plan);
            Bukkit.getScheduler().runTask(plugin, () -> {
                try {
                    apply(plan, server);
                    lastLocal = newLocal;
                    lastServer = newServer;
                } finally {
                    busy = false;
                }
            });
        } catch (Exception e) {
            if (e instanceof InterruptedException) Thread.currentThread().interrupt();
            // History is untouched, so the next tick redoes the same decision.
            plugin.getLogger().warning("ban sync failed: " + e);
            Bukkit.getScheduler().runTask(plugin, () -> busy = false);
        }
    }

    private void apply(BanReconciler.Plan plan, Map<UUID, ApiClient.ServerBan> server) {
        ProfileBanList list = Bukkit.getBanList(BanListType.PROFILE);
        for (UUID u : plan.addLocal()) {
            ApiClient.ServerBan b = server.get(u);
            PlayerProfile profile = Bukkit.createProfileExact(u, b.name());
            list.addBan(profile, b.reason(), (java.time.Instant) null, "web");
            Player p = Bukkit.getPlayer(u);
            if (p != null) p.kick(Component.text(plugin.getConfig().getString("messages.banned", "You are banned.")
                    + (b.reason() == null || b.reason().isBlank() ? "" : "\n" + b.reason())));
        }
        for (UUID u : plan.removeLocal()) list.pardon(Bukkit.createProfileExact(u, null));
    }
}
