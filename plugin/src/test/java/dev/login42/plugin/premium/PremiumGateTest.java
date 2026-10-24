package dev.login42.plugin.premium;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import io.netty.buffer.ByteBuf;
import io.netty.buffer.Unpooled;
import io.netty.channel.embedded.EmbeddedChannel;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.spec.X509EncodedKeySpec;
import java.util.ArrayList;
import java.util.List;
import java.util.logging.Logger;
import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/** Drives the gate like a real client would, over an in-memory Netty channel. */
class PremiumGateTest {
    private static KeyPair keys;
    private final List<String> verifierCalls = new ArrayList<>();
    private final List<String> verifierConnections = new ArrayList<>();
    private PremiumGate.Outcome nextOutcome;

    @BeforeAll
    static void keys() throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance("RSA");
        g.initialize(2048);
        keys = g.generateKeyPair();
    }

    private EmbeddedChannel channel(PremiumGate.Limits limits, String returnOverride) {
        return channel(limits, returnOverride, id -> false);
    }

    private EmbeddedChannel channel(PremiumGate.Limits limits, String returnOverride, java.util.function.Predicate<String> linked) {
        PremiumGate.Verifier verifier = (name, hash, token, ip, host) -> {
            verifierCalls.add(name + "|" + hash + "|" + token);
            verifierConnections.add(ip + "|" + host);
            return nextOutcome != null ? nextOutcome : PremiumGate.Outcome.message("Verified as " + name + ". Your code: TESTCODE");
        };
        return new EmbeddedChannel(new PremiumGate("verify.", keys, verifier, Runnable::run, limits, Logger.getAnonymousLogger(), returnOverride, linked, "offline."));
    }

    private EmbeddedChannel channel() {
        return channel(new PremiumGate.Limits(60, 3), "");
    }

    // --- client side helpers ---

    private static byte[] handshake(String host, int intent, int protocol) {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        McProtocol.writeVarInt(b, protocol);
        McProtocol.writeString(b, host);
        b.write(0x5E);
        b.write(0xB2); // port 24242
        McProtocol.writeVarInt(b, intent);
        return McProtocol.frame(0, b.toByteArray());
    }

    private static byte[] handshake(String host, int intent) {
        return handshake(host, intent, 777);
    }

    private static byte[] loginStart(String name) {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        McProtocol.writeString(b, name);
        b.writeBytes(new byte[16]);
        return McProtocol.frame(0, b.toByteArray());
    }

    private static byte[] cat(byte[]... parts) {
        return McProtocol.concat(parts);
    }

    private static byte[] drainOutbound(EmbeddedChannel ch) {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        for (ByteBuf b; (b = ch.readOutbound()) != null; ) {
            byte[] x = new byte[b.readableBytes()];
            b.readBytes(x);
            b.release();
            o.writeBytes(x);
        }
        return o.toByteArray();
    }

    private static byte[] rsa(PublicKey key, byte[] data) throws Exception {
        Cipher c = Cipher.getInstance("RSA/ECB/PKCS1Padding");
        c.init(Cipher.ENCRYPT_MODE, key);
        return c.doFinal(data);
    }

    private record Packet(int id, McProtocol.Reader body) {}

    private static List<Packet> parse(byte[] stream) {
        List<Packet> out = new ArrayList<>();
        int off = 0;
        while (off < stream.length) {
            int[] len = McProtocol.readVarInt(stream, off);
            byte[] one = java.util.Arrays.copyOfRange(stream, off + len[1], off + len[1] + len[0]);
            McProtocol.Reader r = new McProtocol.Reader(one, 0);
            out.add(new Packet(r.varInt(), r));
            off += len[1] + len[0];
        }
        return out;
    }

    /** A fake Minecraft client: does the RSA/AES exchange and then talks over the encrypted stream. */
    private final class Client {
        final EmbeddedChannel ch;
        byte[] secret;
        byte[] publicDer;
        Cipher enc;
        Cipher dec;

        Client(EmbeddedChannel ch) {
            this.ch = ch;
        }

        void connect(String host, int intent, int protocol, String name) throws Exception {
            ch.writeInbound(Unpooled.wrappedBuffer(cat(handshake(host, intent, protocol), loginStart(name))));
            assertNull(ch.readInbound(), "the server must never see a verifier connection");
            List<Packet> p = parse(drainOutbound(ch));
            assertEquals(1, p.size());
            McProtocol.Reader r = p.get(0).body();
            assertEquals(1, p.get(0).id(), "Encryption Request");
            assertEquals("", r.string(20));
            publicDer = r.byteArray(1024);
            byte[] token = r.byteArray(64);
            assertEquals(1, r.bytes(1)[0], "client must be told to authenticate with Mojang");
            PublicKey pub = KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(publicDer));
            secret = new byte[16];
            new SecureRandom().nextBytes(secret);
            enc = Cipher.getInstance("AES/CFB8/NoPadding");
            enc.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(secret, "AES"), new IvParameterSpec(secret));
            dec = Cipher.getInstance("AES/CFB8/NoPadding");
            dec.init(Cipher.DECRYPT_MODE, new SecretKeySpec(secret, "AES"), new IvParameterSpec(secret));
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            McProtocol.writeBytes(b, rsa(pub, secret));
            McProtocol.writeBytes(b, rsa(pub, token));
            ch.writeInbound(Unpooled.wrappedBuffer(McProtocol.frame(1, b.toByteArray())));
        }

        List<Packet> read() {
            byte[] raw = drainOutbound(ch);
            return raw.length == 0 ? List.of() : parse(dec.update(raw));
        }

        void send(int id, byte[] body) {
            ch.writeInbound(Unpooled.wrappedBuffer(enc.update(McProtocol.frame(id, body))));
            ch.runPendingTasks();
        }

        /** Answers the server's login Cookie Request with the given value (null = no cookie stored). */
        void answerCookieRequest(String expectedKey, String value) {
            List<Packet> p = read();
            assertEquals(1, p.size());
            assertEquals(5, p.get(0).id(), "Cookie Request (login)");
            assertEquals(expectedKey, p.get(0).body().string(256));
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            McProtocol.writeString(b, expectedKey);
            if (value == null) {
                b.write(0);
            } else {
                b.write(1);
                McProtocol.writeBytes(b, value.getBytes(StandardCharsets.UTF_8));
            }
            send(4, b.toByteArray());
        }
    }

    // --- tests ---

    @Test
    void manualConnectionGetsACodeInAnEncryptedDisconnect() throws Exception {
        EmbeddedChannel ch = channel();
        Client c = new Client(ch);
        c.connect("verify.g.zoe.dev.br", 2, 777, "PremiumPlayer");
        c.answerCookieRequest("login42:premium", null);

        assertEquals(1, verifierCalls.size());
        assertEquals("PremiumPlayer|" + McProtocol.serverHash(new byte[0], c.secret, c.publicDer) + "|null", verifierCalls.get(0), "exactly the hash a real client reports to Mojang, no token");
        assertEquals("?|verify.g.zoe.dev.br:24242", verifierConnections.get(0), "the connection address and host reach the audit (embedded channels have no IP)");
        List<Packet> out = c.read();
        assertEquals(1, out.size());
        assertEquals(0, out.get(0).id(), "Disconnect (login)");
        JsonObject text = new Gson().fromJson(out.get(0).body().string(32767), JsonObject.class);
        assertEquals("Verified as PremiumPlayer. Your code: TESTCODE", text.get("text").getAsString());
        assertFalse(ch.isOpen());
    }

    @Test
    void cookieTokenLinksDirectlyAndTransfersThePlayerBack() throws Exception {
        nextOutcome = new PremiumGate.Outcome("Linked", "069a79f444e94726a5befca90e38aaf5", "Notch", "SESSIONTOKEN123456");
        EmbeddedChannel ch = channel();
        Client c = new Client(ch);
        c.connect("verify.42.g.zoe.dev.br", 3, 777, "Notch");
        c.answerCookieRequest("login42:premium", "premiumtoken1234567890");
        assertTrue(verifierCalls.get(0).endsWith("|premiumtoken1234567890"), "the token from the cookie reaches the verifier");

        // 1) Login Success: profile uuid, name, no properties, and a session id for protocol 777
        List<Packet> success = c.read();
        assertEquals(1, success.size());
        assertEquals(2, success.get(0).id());
        McProtocol.Reader r = success.get(0).body();
        assertArrayEquals(new byte[] {0x06, (byte) 0x9a, 0x79, (byte) 0xf4, 0x44, (byte) 0xe9, 0x47, 0x26, (byte) 0xa5, (byte) 0xbe, (byte) 0xfc, (byte) 0xa9, 0x0e, 0x38, (byte) 0xaa, (byte) 0xf5}, r.bytes(16));
        assertEquals("Notch", r.string(16));
        assertEquals(0, r.varInt());
        r.bytes(16); // session id
        assertEquals(0, r.remaining());
        assertTrue(ch.isOpen(), "still open: the transfer comes after the client acknowledges");

        // 2) client acknowledges -> configuration state: Store Cookie, then Transfer back to the host without the prefix
        c.send(3, new byte[0]);
        List<Packet> config = c.read();
        assertEquals(2, config.size());
        assertEquals(0x0B, config.get(0).id());
        assertEquals("login42:session", config.get(0).body().string(256));
        assertEquals("SESSIONTOKEN123456", new String(config.get(0).body().byteArray(5120), StandardCharsets.UTF_8));
        assertEquals(0x0C, config.get(1).id());
        assertEquals("42.g.zoe.dev.br", config.get(1).body().string(32767));
        assertEquals(24242, config.get(1).body().varInt());
    }

    @Test
    void returningVerifiedPlayerTransfersBackWithoutAnyStoredCookie() throws Exception {
        nextOutcome = new PremiumGate.Outcome("Welcome back", "069a79f444e94726a5befca90e38aaf5", "Notch", "FRESHSESSIONTOKEN123");
        Client c = new Client(channel(new PremiumGate.Limits(60, 3), "42.g.zoe.dev.br:24242"));
        c.connect("verify.g.zoe.dev.br", 2, 777, "Notch");
        c.answerCookieRequest("login42:premium", null);
        assertTrue(verifierCalls.get(0).endsWith("|null"));
        assertEquals(2, c.read().get(0).id(), "a returning verified player gets Login Success, not a code");
        c.send(3, new byte[0]);
        List<Packet> config = c.read();
        assertEquals("login42:session", config.get(0).body().string(256));
        assertEquals("FRESHSESSIONTOKEN123", new String(config.get(0).body().byteArray(5120), StandardCharsets.UTF_8));
        assertEquals("42.g.zoe.dev.br", config.get(1).body().string(32767));
        assertEquals(24242, config.get(1).body().varInt());
    }

    @Test
    void linkedUuidOnTheNormalAddressRequiresMojangAndNeedsNoCookie() throws Exception {
        nextOutcome = new PremiumGate.Outcome("Welcome back", "069a79f444e94726a5befca90e38aaf5", "Notch", "SESSIONTOKEN123456");
        Client c = new Client(channel(new PremiumGate.Limits(60, 3), "42.g.zoe.dev.br:24242", id -> id.equals("0".repeat(32))));
        c.connect("42craft.zoe.dev.br", 2, 777, "Notch");
        c.answerCookieRequest("login42:premium", null);
        assertEquals(2, c.read().get(0).id(), "real Mojang verification is followed by Login Success");
        assertEquals(1, verifierCalls.size());
        c.send(3, new byte[0]);
        assertEquals(2, c.read().size(), "one-use cookie and transfer back");
    }

    @Test
    void aLinkedUuidHintNeverGrantsAccessWhenMojangVerificationFails() throws Exception {
        nextOutcome = PremiumGate.Outcome.message("Mojang did not confirm ownership");
        Client c = new Client(channel(new PremiumGate.Limits(60, 3), "", id -> true));
        c.connect("42craft.zoe.dev.br", 2, 777, "Impersonator");
        c.answerCookieRequest("login42:premium", null);
        assertEquals(0, c.read().get(0).id(), "a UUID hint alone must end in Disconnect, never Login Success");
        assertFalse(c.ch.isOpen());
    }

    @Test
    void transferBackIsNotInterceptedEvenWhenTheClientHasALinkedUuid() {
        EmbeddedChannel ch = channel(new PremiumGate.Limits(60, 3), "", id -> true);
        byte[] sent = cat(handshake("42.g.zoe.dev.br", 3), loginStart("Notch"));
        ch.writeInbound(Unpooled.wrappedBuffer(sent));
        ByteBuf got = ch.readInbound();
        byte[] bytes = new byte[got.readableBytes()];
        got.readBytes(bytes); got.release();
        assertArrayEquals(sent, bytes);
        assertEquals(0, drainOutbound(ch).length, "must not create a verification/transfer loop");
    }

    @Test
    void fragmentedNormalLoginWaitsForTheUuidBeforeChoosingMojangAuthentication() {
        EmbeddedChannel ch = channel(new PremiumGate.Limits(60, 3), "", id -> true);
        ch.writeInbound(Unpooled.wrappedBuffer(handshake("42craft.zoe.dev.br", 2)));
        assertNull(ch.readInbound());
        assertEquals(0, drainOutbound(ch).length);
        byte[] start = loginStart("Notch");
        for (byte b : start) ch.writeInbound(Unpooled.wrappedBuffer(new byte[] {b}));
        assertEquals(1, parse(drainOutbound(ch)).get(0).id(), "Encryption Request");
        assertNull(ch.readInbound());
    }

    @Test
    void explicitOfflineHostUsesTheBrowserPathEvenForALinkedClient() {
        EmbeddedChannel ch = channel(new PremiumGate.Limits(60, 3), "", id -> true);
        ch.writeInbound(Unpooled.wrappedBuffer(cat(handshake("offline.42.g.zoe.dev.br", 2), loginStart("Notch"))));
        assertNotNull(ch.readInbound());
        assertEquals(0, drainOutbound(ch).length);
    }

    @Test
    void olderProtocolsGetLoginSuccessWithoutASessionId() throws Exception {
        nextOutcome = new PremiumGate.Outcome("Linked", "069a79f444e94726a5befca90e38aaf5", "Notch", "SESSIONTOKEN123456");
        Client c = new Client(channel());
        c.connect("verify.42.g.zoe.dev.br", 3, 776, "Notch");
        c.answerCookieRequest("login42:premium", "premiumtoken1234567890");
        McProtocol.Reader r = c.read().get(0).body();
        r.bytes(16);
        r.string(16);
        r.varInt();
        assertEquals(0, r.remaining(), "no session id before protocol 777");
    }

    @Test
    void returnAddressOverrideWins() throws Exception {
        nextOutcome = new PremiumGate.Outcome("Linked", "069a79f444e94726a5befca90e38aaf5", "Notch", "SESSIONTOKEN123456");
        Client c = new Client(channel(new PremiumGate.Limits(60, 3), "play.example.com:25565"));
        c.connect("verify.42.g.zoe.dev.br", 3, 777, "Notch");
        c.answerCookieRequest("login42:premium", "premiumtoken1234567890");
        c.read();
        c.send(3, new byte[0]);
        Packet transfer = c.read().get(1);
        assertEquals("play.example.com", transfer.body().string(32767));
        assertEquals(25565, transfer.body().varInt());
    }

    @Test
    void aWrongOrMalformedCookieIsTreatedAsNoCookie() throws Exception {
        Client c = new Client(channel());
        c.connect("verify.g.zoe.dev.br", 3, 777, "Someone");
        c.answerCookieRequest("login42:premium", "has spaces and ../symbols");
        assertTrue(verifierCalls.get(0).endsWith("|null"));
    }

    @Test
    void normalHostsAreHandedOnByteForByteAndTheGateRemovesItself() {
        EmbeddedChannel ch = channel();
        byte[] sent = cat(handshake("42craft.zoe.dev.br", 2), loginStart("Steve"));
        ch.writeInbound(Unpooled.wrappedBuffer(sent));
        ByteBuf got = ch.readInbound();
        byte[] seen = new byte[got.readableBytes()];
        got.readBytes(seen);
        assertArrayEquals(sent, seen);
        assertEquals(0, drainOutbound(ch).length, "the gate must not answer normal connections");
        assertNull(ch.pipeline().get(PremiumGate.class), "gate removes itself");
        assertTrue(verifierCalls.isEmpty());
    }

    @Test
    void statusPingsToTheVerifierHostAreNotIntercepted() {
        EmbeddedChannel ch = channel();
        ch.writeInbound(Unpooled.wrappedBuffer(handshake("verify.g.zoe.dev.br", 1)));
        assertNotNull(ch.readInbound(), "status goes to the server");
        assertEquals(0, drainOutbound(ch).length);
    }

    @Test
    void fragmentedHandshakeStillWorks() {
        EmbeddedChannel ch = channel();
        byte[] all = cat(handshake("verify.g.zoe.dev.br", 2), loginStart("Slow"));
        for (int i = 0; i < all.length; i += 3) ch.writeInbound(Unpooled.wrappedBuffer(all, i, Math.min(3, all.length - i)));
        assertNull(ch.readInbound());
        assertEquals(1, parse(drainOutbound(ch)).get(0).id());
    }

    @Test
    void legacyServerListPingIsPassedThrough() {
        EmbeddedChannel ch = channel();
        ch.writeInbound(Unpooled.wrappedBuffer(new byte[] {(byte) 0xFE, 0x01}));
        assertNotNull(ch.readInbound());
    }

    @Test
    void wrongVerifyTokenClosesTheConnectionWithoutCallingMojang() throws Exception {
        EmbeddedChannel ch = channel();
        ch.writeInbound(Unpooled.wrappedBuffer(cat(handshake("verify.g.zoe.dev.br", 2), loginStart("Bad"))));
        List<Packet> p = parse(drainOutbound(ch));
        McProtocol.Reader r = p.get(0).body();
        r.string(20);
        PublicKey pub = KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(r.byteArray(1024)));
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        McProtocol.writeBytes(b, rsa(pub, new byte[16]));
        McProtocol.writeBytes(b, rsa(pub, new byte[] {9, 9, 9, 9}));
        ch.writeInbound(Unpooled.wrappedBuffer(McProtocol.frame(1, b.toByteArray())));
        ch.runPendingTasks();
        assertFalse(ch.isOpen());
        assertTrue(verifierCalls.isEmpty());
    }

    @Test
    void garbageEncryptionResponseClosesTheConnection() {
        EmbeddedChannel ch = channel();
        ch.writeInbound(Unpooled.wrappedBuffer(cat(handshake("verify.g.zoe.dev.br", 2), loginStart("Bad"))));
        drainOutbound(ch);
        byte[] junk = new byte[256];
        new SecureRandom().nextBytes(junk);
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        McProtocol.writeBytes(b, junk);
        McProtocol.writeBytes(b, junk);
        ch.writeInbound(Unpooled.wrappedBuffer(McProtocol.frame(1, b.toByteArray())));
        ch.runPendingTasks();
        assertFalse(ch.isOpen());
        assertTrue(verifierCalls.isEmpty());
    }

    @Test
    void invalidPlayerNamesAreRejected() {
        EmbeddedChannel ch = channel();
        ch.writeInbound(Unpooled.wrappedBuffer(cat(handshake("verify.g.zoe.dev.br", 2), loginStart("bad name!"))));
        assertFalse(ch.isOpen());
    }

    @Test
    void connectionLimitRefusesTheFourthSimultaneousConnection() {
        PremiumGate.Limits limits = new PremiumGate.Limits(60, 3);
        List<EmbeddedChannel> open = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            EmbeddedChannel ch = channel(limits, "");
            ch.writeInbound(Unpooled.wrappedBuffer(cat(handshake("verify.g.zoe.dev.br", 2), loginStart("P" + i))));
            assertTrue(ch.isOpen());
            open.add(ch);
        }
        EmbeddedChannel fourth = channel(limits, "");
        fourth.writeInbound(Unpooled.wrappedBuffer(cat(handshake("verify.g.zoe.dev.br", 2), loginStart("P4"))));
        assertFalse(fourth.isOpen(), "per-address cap applies");
        open.get(0).close();
        EmbeddedChannel fifth = channel(limits, "");
        fifth.writeInbound(Unpooled.wrappedBuffer(cat(handshake("verify.g.zoe.dev.br", 2), loginStart("P5"))));
        assertTrue(fifth.isOpen(), "a slot frees when a connection closes");
    }
}
