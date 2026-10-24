package dev.login42.plugin.premium;

import dev.login42.plugin.ApiClient;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.util.List;
import java.util.concurrent.Executor;
import java.util.logging.Logger;
import org.bukkit.Bukkit;
import org.bukkit.plugin.Plugin;

/**
 * Premium-ownership verifier, hosted inside the server. Players connect to a host starting with the
 * configured prefix (default "verify."); Mojang itself proves who they are, and they get a one-time code
 * to enter on the web profile page. Already-linked accounts instead receive a fresh transfer token
 * and rejoin as their 42 identity without browser sign-in. Nothing is stored here.
 */
public final class PremiumVerifier {
    private PremiumVerifier() {}

    private static String bindError(String error) {
        if (error == null) return "Could not link the account. Try /premium again.";
        if (error.contains("already linked")) return "That Minecraft account is already linked to another player. Ask an admin if this is a mistake.";
        if (error.contains("expired") || error.contains("invalid")) return "That request expired. Type /premium in game again.";
        return "Could not link the account: " + error;
    }

    /** Installs the gate on every listening channel. Returns false (and logs) if the server's internals are not what we expect. */
    public static boolean install(Plugin plugin, ApiClient api, String hostPrefix, String sessionUrl, String profileUrl, String returnAddress, Executor async) {
        Logger log = plugin.getLogger();
        try {
            KeyPairGenerator gen = KeyPairGenerator.getInstance("RSA");
            gen.initialize(2048); // the protocol allows keys longer than vanilla's 1024
            KeyPair keys = gen.generateKeyPair();
            SessionServer session = new SessionServer(sessionUrl);
            PremiumGate.Limits limits = new PremiumGate.Limits(60, 3);
            var linked = new java.util.concurrent.atomic.AtomicReference<java.util.Set<String>>(java.util.Set.of());
            boolean autoLogin = plugin.getConfig().getBoolean("premium.auto-login", true);
            if (autoLogin) plugin.getServer().getScheduler().runTaskTimerAsynchronously(plugin, () -> {
                try {
                    var next = api.premiumAccounts();
                    var previous = linked.getAndSet(next);
                    if (!next.equals(previous)) log.info("Premium automatic login ready for " + next.size() + " linked account(s)");
                } catch (Exception e) {
                    if (e instanceof InterruptedException) Thread.currentThread().interrupt();
                    log.warning("Could not refresh premium login hints: " + e);
                }
            }, 0L, 600L);
            PremiumGate.Verifier verifier = (name, hash, premiumToken, ip, host) -> {
                SessionServer.Profile who = session.hasJoined(name, hash);
                if (who == null) return PremiumGate.Outcome.message("Mojang could not confirm this account. Sign in to the Minecraft launcher with a Microsoft account and try again.");
                if (premiumToken != null) {
                    // The player asked for this in game (/premium): bind straight to their 42 account, no code to type.
                    ApiClient.BindResult r = api.premiumBind(premiumToken, who.uuid(), who.name(), who.textureValue(), who.textureSignature(), ip, host);
                    if (r.ok()) {
                        linked.updateAndGet(old -> {
                            var next = new java.util.HashSet<>(old);
                            next.add(who.uuid().replace("-", "").toLowerCase(java.util.Locale.ROOT));
                            return java.util.Set.copyOf(next);
                        });
                        return new PremiumGate.Outcome("Linked " + who.name() + " to " + r.login(), who.uuid(), who.name(), r.sessionToken());
                    }
                    return PremiumGate.Outcome.message(bindError(r.error()));
                }
                ApiClient.BindResult returning = api.premiumLogin(who.uuid(), who.name(), ip, host);
                if (returning.ok()) {
                    log.info("Mojang-verified returning login for " + returning.login());
                    return new PremiumGate.Outcome("Welcome back " + returning.login(), who.uuid(), who.name(), returning.sessionToken());
                }
                // Only unlinked players get the linking-code flow. Bans and 42 failures stay denied.
                if (!"not linked".equals(returning.error())) return PremiumGate.Outcome.message("Login denied: " + returning.error());
                String code = api.premiumProof(who.uuid(), who.name(), ip, host);
                return PremiumGate.Outcome.message("Verified as " + who.name() + ". Your code: " + code + " (valid 10 minutes). Enter it at " + profileUrl);
            };
            List<io.netty.channel.ChannelFuture> channels = NettyInjector.listeningChannels(Bukkit.getServer());
            if (channels.isEmpty()) {
                log.warning("premium verifier: no listening channels found; verifier disabled");
                return false;
            }
            NettyInjector.install(channels, () -> new PremiumGate(hostPrefix, keys, verifier, async, limits, log, returnAddress,
                    id -> autoLogin && linked.get().contains(id), plugin.getConfig().getString("premium.browser-host-prefix", "offline.")));
            log.info("premium verifier active on hosts starting with \"" + hostPrefix + "\" (" + channels.size() + " listener(s))");
            return true;
        } catch (ReflectiveOperationException | RuntimeException | java.security.GeneralSecurityException e) {
            log.warning("premium verifier disabled: " + e);
            return false;
        }
    }
}
