package dev.login42.plugin;

import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

/**
 * Decides how to merge the local ban list with the web service's, given what each looked like at the
 * previous reconcile. A ban missing on one side was either added on the other (copy it over) or removed
 * on this one since last time (propagate the removal). The first run (null history) treats every
 * difference as an addition, so a restart can never silently pardon anyone.
 */
final class BanReconciler {
    record Plan(Set<UUID> pushBans, Set<UUID> pushPardons, Set<UUID> addLocal, Set<UUID> removeLocal) {}

    private BanReconciler() {}

    static Plan plan(Set<UUID> local, Set<UUID> server, Set<UUID> lastLocal, Set<UUID> lastServer) {
        Set<UUID> pushBans = new HashSet<>();
        Set<UUID> removeLocal = new HashSet<>();
        for (UUID u : local) {
            if (server.contains(u)) continue;
            // On the server before, gone now: it was pardoned on the web.
            if (lastServer != null && lastServer.contains(u)) removeLocal.add(u);
            else pushBans.add(u);
        }
        Set<UUID> addLocal = new HashSet<>();
        Set<UUID> pushPardons = new HashSet<>();
        for (UUID u : server) {
            if (local.contains(u)) continue;
            // Local before, gone now: it was pardoned in game.
            if (lastLocal != null && lastLocal.contains(u)) pushPardons.add(u);
            else addLocal.add(u);
        }
        return new Plan(pushBans, pushPardons, addLocal, removeLocal);
    }

    /** The two sets as they will look once the plan has been applied. */
    static Set<UUID> localAfter(Set<UUID> local, Plan p) {
        Set<UUID> s = new HashSet<>(local);
        s.removeAll(p.removeLocal());
        s.addAll(p.addLocal());
        return s;
    }

    static Set<UUID> serverAfter(Set<UUID> server, Plan p) {
        Set<UUID> s = new HashSet<>(server);
        s.addAll(p.pushBans());
        s.removeAll(p.pushPardons());
        return s;
    }
}
