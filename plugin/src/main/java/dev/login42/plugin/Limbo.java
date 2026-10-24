package dev.login42.plugin;

import java.io.File;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.event.ClickEvent;
import net.kyori.adventure.text.format.NamedTextColor;
import org.bukkit.Bukkit;
import org.bukkit.GameMode;
import org.bukkit.Location;
import org.bukkit.NamespacedKey;
import org.bukkit.World;
import org.bukkit.WorldCreator;
import org.bukkit.entity.Player;
import org.bukkit.generator.ChunkGenerator;
import org.bukkit.scheduler.BukkitTask;

/** The void world unauthenticated connections wait in, and the guest bookkeeping around it. */
final class Limbo {
    static final NamespacedKey COOKIE = new NamespacedKey("login42", "session");
    private static final long MAX_WAIT_TICKS = 10 * 60 * 20L;
    private static final long POLL_TICKS = 40L;

    private final Login42Plugin plugin;
    private final ApiClient api;
    /** guest profile uuid -> guest info, filled in pre-login */
    final Map<UUID, Guest> guests = new ConcurrentHashMap<>();
    private final Map<UUID, BukkitTask> pollTasks = new ConcurrentHashMap<>();
    private World world;

    Limbo(Login42Plugin plugin, ApiClient api) {
        this.plugin = plugin;
        this.api = api;
    }

    /**
     * Pre-login registers a guest, but PlayerQuitEvent only fires for connections that finished joining. A client that drops
     * (or is refused by another plugin) in between would hold a slot forever, so drop entries that never became a player.
     */
    void startSweeper() {
        Bukkit.getScheduler().runTaskTimer(plugin, () -> {
            long cutoff = System.currentTimeMillis() - 60_000L;
            guests.entrySet().removeIf(e -> e.getValue().createdAt() < cutoff && Bukkit.getPlayer(e.getKey()) == null);
        }, 600L, 600L);
    }

    void createWorld() {
        // A ChunkGenerator that generates nothing yields a void world.
        world = Bukkit.createWorld(new WorldCreator("login42_limbo").generator(new ChunkGenerator() {}).generateStructures(false));
        if (world == null) throw new IllegalStateException("could not create limbo world");
    }

    Location spawn() {
        return new Location(world, 0.5, 100, 0.5);
    }

    /** Caps concurrent unauthenticated connections overall and per source address. */
    ApiClient api() {
        return api;
    }

    boolean hasRoom(String ip) {
        int max = plugin.getConfig().getInt("limbo.max-guests", 40);
        int perIp = plugin.getConfig().getInt("limbo.max-guests-per-ip", 3);
        if (guests.size() >= max) return false;
        return guests.values().stream().filter(g -> g.ip().equals(ip)).count() < perIp;
    }

    /**
     * Vanilla broadcasts join/quit/death/advancement lines to everyone. Guests must not learn who is online,
     * so these go to real players and the console only.
     */
    void announce(net.kyori.adventure.text.Component message) {
        if (message == null) return;
        Bukkit.getConsoleSender().sendMessage(message);
        for (Player p : Bukkit.getOnlinePlayers()) if (!isGuest(p)) p.sendMessage(message);
    }

    boolean isGuest(Player p) {
        return guests.containsKey(p.getUniqueId());
    }

    /** Hide guests from everyone and everyone from guests (tab list and entities). */
    void isolate(Player joined) {
        boolean joinedGuest = isGuest(joined);
        for (Player other : Bukkit.getOnlinePlayers()) {
            if (other.equals(joined)) continue;
            if (joinedGuest || isGuest(other)) {
                joined.hidePlayer(plugin, other);
                other.hidePlayer(plugin, joined);
            }
        }
    }

    void startGuest(Player p) {
        Guest g = guests.get(p.getUniqueId());
        p.setGameMode(GameMode.ADVENTURE);
        p.setInvulnerable(true);
        p.setAllowFlight(true);
        p.setFlying(true);
        isolate(p);
        Component link = Component.text(g.url(), NamedTextColor.AQUA).clickEvent(ClickEvent.openUrl(g.url()));
        p.sendMessage(Component.text(plugin.getConfig().getString("messages.limbo-prompt", "Sign in with your 42 account:"), NamedTextColor.YELLOW));
        p.sendMessage(link);
        if (plugin.getConfig().getBoolean("premium.enabled", true)) {
            p.sendMessage(Component.text(plugin.getConfig().getString("messages.limbo-premium-hint",
                    "Own the game? After signing in, type /premium to link your Mojang account (it gives you your skin)."), NamedTextColor.GRAY));
        }

        long[] waited = {0};
        BukkitTask task = Bukkit.getScheduler().runTaskTimerAsynchronously(plugin, () -> {
            waited[0] += POLL_TICKS;
            try {
                ApiClient.LimboPoll r = api.pollLimbo(g.code());
                switch (r.status()) {
                    case "done" -> finish(p, g, r.token());
                    case "failed" -> kick(p, plugin.getConfig().getString("messages.limbo-failed", "Sign-in was rejected. Check the web page, then rejoin."));
                    case "expired" -> kick(p, plugin.getConfig().getString("messages.limbo-expired", "Link expired. Rejoin to get a new one."));
                    default -> {
                        if (waited[0] >= MAX_WAIT_TICKS) kick(p, plugin.getConfig().getString("messages.limbo-expired", "Link expired. Rejoin to get a new one."));
                    }
                }
            } catch (Exception e) {
                if (e instanceof InterruptedException) Thread.currentThread().interrupt();
                plugin.getLogger().warning("limbo poll failed: " + e);
            }
        }, POLL_TICKS, POLL_TICKS);
        pollTasks.put(p.getUniqueId(), task);
    }

    // Hand the client its session cookie, then reconnect it to this same server as its real identity.
    private void finish(Player p, Guest g, String token) {
        stop(p.getUniqueId());
        Bukkit.getScheduler().runTask(plugin, () -> {
            if (!p.isOnline()) return;
            try {
                p.storeCookie(COOKIE, token.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                p.transfer(g.transferHost(), g.transferPort());
            } catch (Exception e) {
                plugin.getLogger().warning("limbo handoff failed: " + e);
                p.kick(Component.text("Could not complete sign-in. Rejoin and try again."));
            }
        });
    }

    private void kick(Player p, String message) {
        stop(p.getUniqueId());
        Bukkit.getScheduler().runTask(plugin, () -> p.kick(Component.text(message)));
    }

    private void stop(UUID id) {
        BukkitTask t = pollTasks.remove(id);
        if (t != null) t.cancel();
    }

    /** Guest left (or was transferred): stop polling and remove the throwaway player data. */
    void endGuest(Player p) {
        UUID id = p.getUniqueId();
        stop(id);
        guests.remove(id);
        // Player data is written after quit; remove it one second later. Paths as observed on Paper 26.x.
        Bukkit.getScheduler().runTaskLater(plugin, () -> {
            File root = new File(Bukkit.getWorlds().get(0).getWorldFolder(), "players");
            for (String rel : new String[] {"data/" + id + ".dat", "stats/" + id + ".json", "advancements/" + id + ".json"}) {
                File f = new File(root, rel);
                if (f.exists() && !f.delete()) plugin.getLogger().warning("could not delete guest file " + f);
            }
        }, 20L);
    }

    Set<UUID> guestIds() {
        return guests.keySet();
    }
}
