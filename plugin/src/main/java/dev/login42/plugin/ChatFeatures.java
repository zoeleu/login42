package dev.login42.plugin;

import io.papermc.paper.command.brigadier.BasicCommand;
import io.papermc.paper.command.brigadier.CommandSourceStack;
import io.papermc.paper.event.player.AsyncChatEvent;
import io.papermc.paper.plugin.lifecycle.event.types.LifecycleEvents;
import java.util.Collection;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.format.TextColor;
import net.luckperms.api.LuckPerms;
import net.luckperms.api.node.types.MetaNode;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerQuitEvent;

/** LuckPerms persists colors by the authenticated, 42-derived UUID, never by the client name. */
final class ChatFeatures implements Listener, BasicCommand {
    private record Title(String text, long receivedAt) {}
    private final Login42Plugin plugin;
    private final Limbo limbo;
    private final LuckPerms permissions;
    private final Map<UUID, Title> titles = new ConcurrentHashMap<>();
    private final Set<UUID> saving = ConcurrentHashMap.newKeySet();

    ChatFeatures(Login42Plugin plugin, Limbo limbo) {
        this.plugin = plugin;
        this.limbo = limbo;
        this.permissions = java.util.Objects.requireNonNull(plugin.getServer().getServicesManager().load(LuckPerms.class), "LuckPerms API unavailable");
    }

    void register() {
        plugin.getServer().getPluginManager().registerEvents(this, plugin);
        plugin.getLifecycleManager().registerEventHandler(LifecycleEvents.COMMANDS, event ->
                event.registrar().register("chatcolor", "Choose your chat color (name, #RRGGBB, or reset)", List.of("chatcolour"), this));
        // A pre-login can be abandoned before PlayerQuitEvent. Drop only stale, offline entries.
        plugin.getServer().getScheduler().runTaskTimer(plugin, () -> {
            long cutoff = System.currentTimeMillis() - 300_000;
            titles.entrySet().removeIf(e -> e.getValue().receivedAt() < cutoff && plugin.getServer().getPlayer(e.getKey()) == null);
        }, 6000L, 6000L);
        plugin.getLogger().info("Chat colors enabled with LuckPerms; Intra titles appear on chat-name hover.");
    }

    void setTitle(UUID id, String title) {
        if (title == null || title.isBlank()) titles.remove(id);
        else titles.put(id, new Title(title, System.currentTimeMillis()));
    }

    @EventHandler(priority = EventPriority.HIGH, ignoreCancelled = true)
    public void onChat(AsyncChatEvent event) {
        Player p = event.getPlayer();
        if (limbo.isGuest(p)) return;
        // Cached LuckPerms data: no network or disk access on the chat path.
        String stored = permissions.getPlayerAdapter(Player.class).getMetaData(p).getMetaValue(ChatStyle.COLOR_KEY);
        TextColor color = ChatStyle.color(stored);
        Title title = titles.get(p.getUniqueId());
        String name = p.getName();
        event.renderer((source, displayName, message, viewer) -> ChatStyle.render(name, color, title == null ? null : title.text(), message));
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent event) {
        titles.remove(event.getPlayer().getUniqueId());
    }

    @Override
    public void execute(CommandSourceStack source, String[] args) {
        if (!(source.getSender() instanceof Player p)) {
            source.getSender().sendMessage(Component.text("Use this command in game to choose your own chat color."));
            return;
        }
        if (limbo.isGuest(p)) return;
        if (args.length != 1) {
            p.sendMessage(Component.text("/chatcolor <color|#RRGGBB|reset> — " + String.join(", ", ChatStyle.choices()), NamedTextColor.YELLOW));
            return;
        }
        boolean reset = args[0].equalsIgnoreCase("reset");
        TextColor color = reset ? null : ChatStyle.color(args[0]);
        if (!reset && color == null) {
            p.sendMessage(Component.text("Unknown color. Use a named color (such as aqua), #RRGGBB, or reset.", NamedTextColor.RED));
            return;
        }
        UUID id = p.getUniqueId();
        if (!saving.add(id)) {
            p.sendMessage(Component.text("Your previous color is still saving. Try again in a moment.", NamedTextColor.YELLOW));
            return;
        }
        // modifyUser loads the canonical UUID, updates only this metadata key, and saves asynchronously.
        permissions.getUserManager().modifyUser(id, user -> {
            user.data().clear(node -> node instanceof MetaNode meta && ChatStyle.COLOR_KEY.equals(meta.getMetaKey()) && node.getContexts().isEmpty());
            if (!reset) user.data().add(MetaNode.builder(ChatStyle.COLOR_KEY, color.asHexString()).build());
        }).whenComplete((ignored, error) -> {
            saving.remove(id);
            if (error != null) plugin.getLogger().warning("Could not save chat color for " + id + ": " + error);
            if (!plugin.isEnabled()) return;
            plugin.getServer().getScheduler().runTask(plugin, () -> {
                if (!p.isOnline()) return;
                p.sendMessage(error != null
                        ? Component.text("Could not save your color. Please try again.", NamedTextColor.RED)
                        : reset ? Component.text("Chat color reset.", NamedTextColor.GREEN)
                        : Component.text("Chat color saved for your 42 account.", color));
            });
        });
    }

    @Override
    public Collection<String> suggest(CommandSourceStack source, String[] args) {
        if (args.length > 1 || !(source.getSender() instanceof Player p) || limbo.isGuest(p)) return List.of();
        String prefix = args.length == 0 ? "" : args[0].toLowerCase(Locale.ROOT);
        return ChatStyle.choices().stream().filter(s -> s.startsWith(prefix)).toList();
    }
}
