package dev.login42.plugin;

import io.papermc.paper.event.player.AsyncChatEvent;
import io.papermc.paper.event.player.AsyncPlayerSpawnLocationEvent;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.Action;
import org.bukkit.event.player.PlayerCommandPreprocessEvent;
import org.bukkit.event.player.PlayerDropItemEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerMoveEvent;
import org.bukkit.event.player.PlayerQuitEvent;

/** Confines limbo guests, spawns them in limbo, and isolates them from real players. */
final class GuestListener implements Listener {
    private static final org.bukkit.NamespacedKey PREMIUM_COOKIE = new org.bukkit.NamespacedKey("login42", "premium");

    private final Login42Plugin plugin;
    private final Limbo limbo;

    GuestListener(Login42Plugin plugin, Limbo limbo) {
        this.plugin = plugin;
        this.limbo = limbo;
    }

    @EventHandler
    public void onSpawnLocation(AsyncPlayerSpawnLocationEvent event) {
        UUID id = event.getConnection().getProfile().getId();
        if (id != null && limbo.guests.containsKey(id)) event.setSpawnLocation(limbo.spawn());
    }

    @EventHandler
    public void onJoin(PlayerJoinEvent event) {
        Player p = event.getPlayer();
        if (limbo.isGuest(p)) {
            event.joinMessage(null);
            limbo.startGuest(p);
        } else {
            limbo.isolate(p);
            limbo.announce(event.joinMessage());
            event.joinMessage(null);
        }
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent event) {
        Player p = event.getPlayer();
        if (limbo.isGuest(p)) {
            event.quitMessage(null);
            limbo.endGuest(p);
        } else {
            limbo.announce(event.quitMessage());
            event.quitMessage(null);
        }
    }

    // Guests cannot speak, and never hear real players either (console and real players still do).
    @EventHandler(priority = EventPriority.LOWEST)
    public void onChat(AsyncChatEvent event) {
        if (limbo.isGuest(event.getPlayer())) {
            event.setCancelled(true);
            return;
        }
        event.viewers().removeIf(a -> a instanceof Player p && limbo.isGuest(p));
    }

    // The server list must not count (or sample) people who have not signed in yet.
    @EventHandler
    public void onPing(com.destroystokyo.paper.event.server.PaperServerListPingEvent event) {
        int guests = limbo.guests.size();
        if (guests > 0) event.setNumPlayers(Math.max(0, event.getNumPlayers() - guests));
        event.getListedPlayers().removeIf(info -> limbo.guests.containsKey(info.id()));
    }

    @EventHandler
    public void onDeath(org.bukkit.event.entity.PlayerDeathEvent event) {
        limbo.announce(event.deathMessage());
        event.deathMessage(null);
    }

    @EventHandler
    public void onAdvancement(org.bukkit.event.player.PlayerAdvancementDoneEvent event) {
        limbo.announce(event.message());
        event.message(null);
    }

    // /premium: a signed-in player asks to link a Mojang account. The plugin gets a one-time token from the web
    // service, stores it in the player's client as a cookie, and transfers them to the verifier host (answered by this
    // plugin). Their own client proves the Mojang account there, the token ties it to this 42 account, and the verifier
    // sends them straight back. It is the only command a limbo guest may type, and guests are told to sign in first.
    @EventHandler(priority = EventPriority.LOWEST)
    public void onCommand(PlayerCommandPreprocessEvent event) {
        Player p = event.getPlayer();
        if (!event.getMessage().trim().equalsIgnoreCase("/premium") || !plugin.getConfig().getBoolean("premium.enabled", true)) {
            if (limbo.isGuest(p)) event.setCancelled(true);
            return;
        }
        event.setCancelled(true);
        if (limbo.isGuest(p)) {
            p.sendMessage(net.kyori.adventure.text.Component.text("Sign in with your 42 account first, then type /premium."));
            return;
        }
        String target = verifyTarget(p);
        if (target == null) {
            p.sendMessage(net.kyori.adventure.text.Component.text("Premium linking is not available right now."));
            return;
        }
        String host = target.substring(0, target.lastIndexOf(':'));
        int port = Integer.parseInt(target.substring(target.lastIndexOf(':') + 1));
        UUID id = p.getUniqueId();
        org.bukkit.Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> {
            try {
                String token = limbo.api().premiumStart(id.toString());
                org.bukkit.Bukkit.getScheduler().runTask(plugin, () -> {
                    if (!p.isOnline()) return;
                    p.sendMessage(net.kyori.adventure.text.Component.text(plugin.getConfig().getString("messages.premium-redirect",
                            "Connecting to Mojang verification. You will come straight back.")));
                    p.storeCookie(PREMIUM_COOKIE, token.getBytes(StandardCharsets.UTF_8));
                    p.transfer(host, port);
                });
            } catch (Exception e) {
                if (e instanceof InterruptedException) Thread.currentThread().interrupt();
                plugin.getLogger().warning("/premium failed for " + p.getName() + ": " + e);
                org.bukkit.Bukkit.getScheduler().runTask(plugin, () -> p.sendMessage(net.kyori.adventure.text.Component.text("Premium linking is not available right now.")));
            }
        });
    }

    /** host:port of the verifier: the configured address, else "verify." + the host the client used. */
    private String verifyTarget(Player p) {
        String configured = plugin.getConfig().getString("premium.verify-address", "");
        if (!configured.isBlank()) return configured;
        java.net.InetSocketAddress vh = p.getVirtualHost();
        if (vh == null) return null;
        String prefix = plugin.getConfig().getString("premium.host-prefix", "verify.");
        String host = vh.getHostString();
        return (host.toLowerCase().startsWith(prefix.toLowerCase()) ? host : prefix + host) + ":" + vh.getPort();
    }

    @EventHandler(priority = EventPriority.LOWEST)
    public void onMove(PlayerMoveEvent event) {
        if (limbo.isGuest(event.getPlayer()) && event.hasChangedPosition()) event.setCancelled(true);
    }

    @EventHandler(priority = EventPriority.LOWEST)
    public void onInteract(PlayerInteractEvent event) {
        if (limbo.isGuest(event.getPlayer()) && event.getAction() != Action.PHYSICAL) event.setCancelled(true);
    }

    @EventHandler(priority = EventPriority.LOWEST)
    public void onDrop(PlayerDropItemEvent event) {
        if (limbo.isGuest(event.getPlayer())) event.setCancelled(true);
    }
}
