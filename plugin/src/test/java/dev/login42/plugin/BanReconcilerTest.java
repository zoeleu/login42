package dev.login42.plugin;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class BanReconcilerTest {
    private static final UUID A = new UUID(0, 1), B = new UUID(0, 2);

    @Test
    void firstRunCopiesDifferencesInBothDirections() {
        var p = BanReconciler.plan(Set.of(A), Set.of(B), null, null);
        assertEquals(Set.of(A), p.pushBans());
        assertEquals(Set.of(B), p.addLocal());
        assertTrue(p.pushPardons().isEmpty() && p.removeLocal().isEmpty(), "a restart must never pardon anyone");
    }

    @Test
    void newLocalBanIsPushed() {
        var p = BanReconciler.plan(Set.of(A), Set.of(), Set.of(), Set.of());
        assertEquals(Set.of(A), p.pushBans());
    }

    @Test
    void newWebBanIsAddedLocally() {
        var p = BanReconciler.plan(Set.of(), Set.of(B), Set.of(), Set.of());
        assertEquals(Set.of(B), p.addLocal());
    }

    @Test
    void webPardonRemovesLocalBan() {
        // A was on both lists last time; now only local has it.
        var p = BanReconciler.plan(Set.of(A), Set.of(), Set.of(A), Set.of(A));
        assertEquals(Set.of(A), p.removeLocal());
        assertTrue(p.pushBans().isEmpty());
    }

    @Test
    void localPardonIsPushed() {
        var p = BanReconciler.plan(Set.of(), Set.of(A), Set.of(A), Set.of(A));
        assertEquals(Set.of(A), p.pushPardons());
        assertTrue(p.addLocal().isEmpty());
    }

    @Test
    void historyAfterApplyingMatchesBothSides() {
        var p = BanReconciler.plan(Set.of(A), Set.of(B), null, null);
        assertEquals(Set.of(A, B), BanReconciler.localAfter(Set.of(A), p));
        assertEquals(Set.of(A, B), BanReconciler.serverAfter(Set.of(B), p));
    }
}
