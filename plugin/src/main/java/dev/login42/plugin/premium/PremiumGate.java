package dev.login42.plugin.premium;

import com.google.gson.JsonObject;
import io.netty.buffer.ByteBuf;
import io.netty.buffer.Unpooled;
import io.netty.channel.ChannelFutureListener;
import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.ChannelInboundHandlerAdapter;
import java.io.ByteArrayOutputStream;
import java.net.InetSocketAddress;
import java.security.KeyPair;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.logging.Logger;
import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * First handler in a connection's pipeline, so it sees raw bytes before the server does. It reads only the
 * handshake and, for normal connections, the Login Start UUID hint. Explicit verifier connections and new
 * connections claiming a linked UUID must prove ownership through the real online-mode handshake.
 * Transfer-back connections, unlinked clients and explicit browser-login hosts pass through unchanged.
 * A verified linked account gets a one-use cookie and transfer into the game; an unlinked account gets
 * a linking code. The underlying server never sees the verifier connection itself.
 */
final class PremiumGate extends ChannelInboundHandlerAdapter {
    /** Does the Mojang check and the web-service call. Runs off the event loop. */
    interface Verifier {
        /** ip and host describe the connection as this server saw it; they are recorded for audit. */
        Outcome verify(String playerName, String serverHash, String premiumToken, String ip, String host) throws Exception;
    }

    /**
     * What to do after the Mojang check. With a session token the player is finished properly (login success) and
     * transferred straight back into the game carrying that token; otherwise they are disconnected with the message.
     */
    record Outcome(String message, String mojangUuid, String mojangName, String sessionToken) {
        static Outcome message(String text) {
            return new Outcome(text, null, null, null);
        }
    }

    /** Shared connection limits for all gates. */
    static final class Limits {
        final int maxTotal;
        final int maxPerIp;
        final AtomicInteger total = new AtomicInteger();
        final Map<String, AtomicInteger> perIp = new ConcurrentHashMap<>();

        Limits(int maxTotal, int maxPerIp) {
            this.maxTotal = maxTotal;
            this.maxPerIp = maxPerIp;
        }

        boolean tryAcquire(String ip) {
            if (total.incrementAndGet() > maxTotal) {
                total.decrementAndGet();
                return false;
            }
            AtomicInteger n = perIp.computeIfAbsent(ip, k -> new AtomicInteger());
            if (n.incrementAndGet() > maxPerIp) {
                n.decrementAndGet();
                total.decrementAndGet();
                return false;
            }
            return true;
        }

        void release(String ip) {
            total.decrementAndGet();
            AtomicInteger n = perIp.get(ip);
            if (n != null && n.decrementAndGet() <= 0) perIp.remove(ip, n);
        }
    }

    private enum State { PROBING, LOGIN, ENCRYPTING, COOKIE, VERIFYING, ACK_WAIT, DONE }

    private static final int MAX_PROBE = 1024;
    private static final int MAX_PACKET = 4096;
    private static final long TIMEOUT_SECONDS = 15;
    private static final String FAILURE = "Mojang could not confirm this account. Sign in to the Minecraft launcher with a Microsoft account and try again.";
    private static final SecureRandom RANDOM = new SecureRandom();
    static final String PREMIUM_COOKIE = "login42:premium";
    static final String SESSION_COOKIE = "login42:session";
    /** Protocol 777 (26.3) added a session id to Login Success; cookies exist since 765 (1.20.5). */
    private static final int SESSION_ID_FROM_PROTOCOL = 777;
    private static final int COOKIES_FROM_PROTOCOL = 765;

    private final String hostPrefix;
    private final KeyPair keys;
    private final byte[] publicDer;
    private final Verifier verifier;
    private final Executor async;
    private final Limits limits;
    private final Logger log;
    private final String returnOverride;
    private final java.util.function.Predicate<String> linkedAccount;
    private final String browserHostPrefix;

    private State state = State.PROBING;
    private byte[] raw = new byte[0];
    private byte[] buf = new byte[0];
    private byte[] verifyToken;
    private String playerName;
    private Cipher encrypt;
    private Cipher decrypt;
    private String limitedIp;
    private int protocol;
    private String hostSeen;
    private int portSeen;
    private String premiumToken;
    private String returnToken;
    private boolean cipherJustEnabled;

    PremiumGate(String hostPrefix, KeyPair keys, Verifier verifier, Executor async, Limits limits, Logger log, String returnOverride) {
        this(hostPrefix, keys, verifier, async, limits, log, returnOverride, id -> false, "offline.");
    }

    PremiumGate(String hostPrefix, KeyPair keys, Verifier verifier, Executor async, Limits limits, Logger log, String returnOverride,
                java.util.function.Predicate<String> linkedAccount, String browserHostPrefix) {
        this.hostPrefix = hostPrefix.toLowerCase();
        this.keys = keys;
        this.publicDer = keys.getPublic().getEncoded(); // X.509 SubjectPublicKeyInfo, as the protocol requires
        this.verifier = verifier;
        this.async = async;
        this.limits = limits;
        this.log = log;
        this.returnOverride = returnOverride == null ? "" : returnOverride;
        this.linkedAccount = linkedAccount;
        this.browserHostPrefix = browserHostPrefix.toLowerCase(java.util.Locale.ROOT);
    }

    @Override
    public void channelRead(ChannelHandlerContext ctx, Object msg) {
        if (!(msg instanceof ByteBuf in)) {
            passThrough(ctx, msg); // e.g. a proxy-protocol message: not ours
            return;
        }
        byte[] bytes = new byte[in.readableBytes()];
        in.readBytes(bytes);
        in.release();

        if (state == State.PROBING) {
            raw = concat(raw, bytes);
            probe(ctx);
            return;
        }
        try {
            if (decrypt != null) bytes = decrypt.update(bytes);
            if (buf.length + bytes.length > MAX_PACKET * 2) {
                ctx.close();
                return;
            }
            buf = concat(buf, bytes);
            drain(ctx);
        } catch (Exception e) {
            ctx.close();
        }
    }

    // --- phase 1: look at the handshake only ---

    private void probe(ChannelHandlerContext ctx) {
        try {
            if (raw.length > 0 && (raw[0] & 0xff) == 0xFE) {
                passThroughRaw(ctx); // legacy server-list ping
                return;
            }
            int[] len = McProtocol.readVarInt(raw, 0);
            if (len == null) {
                if (raw.length > MAX_PROBE) passThroughRaw(ctx);
                return;
            }
            if (len[0] <= 0 || len[0] > 300) {
                passThroughRaw(ctx);
                return;
            }
            int total = len[1] + len[0];
            if (raw.length < total) {
                if (raw.length > MAX_PROBE) passThroughRaw(ctx);
                return;
            }
            McProtocol.Reader r = new McProtocol.Reader(raw, len[1]);
            if (r.varInt() != 0) {
                passThroughRaw(ctx);
                return;
            }
            int proto = r.varInt();
            String host = r.string(255);
            byte[] portBytes = r.bytes(2);
            int intent = r.varInt();
            protocol = proto;
            hostSeen = cleanHost(host);
            portSeen = ((portBytes[0] & 0xff) << 8) | (portBytes[1] & 0xff);
            boolean login = intent == 2 || intent == 3;
            if (!login) {
                passThroughRaw(ctx);
                return;
            }
            if (!isVerifierHost(host)) {
                // A transfer already carries a one-use session cookie: never intercept it again and loop.
                // Only normal new connections with a linked UUID hint enter the Mojang authentication path.
                if (intent == 3 || proto < COOKIES_FROM_PROTOCOL || (!browserHostPrefix.isBlank() && hostSeen.toLowerCase(java.util.Locale.ROOT).startsWith(browserHostPrefix))) {
                    passThroughRaw(ctx);
                    return;
                }
                if (!hasLinkedLoginStart(total)) return; // fragmented Login Start: wait for the rest
                if (!hintIsLinked) {
                    passThroughRaw(ctx);
                    return;
                }
            }
            takeOver(ctx, Arrays.copyOfRange(raw, total, raw.length));
        } catch (Exception e) {
            passThroughRaw(ctx); // not a handshake we understand: let the server deal with it
        }
    }

    private boolean hintIsLinked;

    /** Wait for Login Start (name + claimed UUID). The UUID is a hint, never trusted identity. */
    private boolean hasLinkedLoginStart(int offset) {
        int[] len = McProtocol.readVarInt(raw, offset);
        if (len == null || raw.length < offset + len[1] + len[0]) {
            if (raw.length > MAX_PROBE) throw new IllegalArgumentException("oversized login probe");
            return false;
        }
        if (len[0] <= 0 || len[0] > 128) throw new IllegalArgumentException("bad login start length");
        McProtocol.Reader r = new McProtocol.Reader(Arrays.copyOfRange(raw, offset + len[1], offset + len[1] + len[0]), 0);
        if (r.varInt() != 0) throw new IllegalArgumentException("not Login Start");
        r.string(16);
        byte[] uuid = r.bytes(16);
        hintIsLinked = linkedAccount.test(java.util.HexFormat.of().formatHex(uuid));
        return true;
    }

    /** Strip Forge's "\0FML" suffix and a trailing dot. */
    private static String cleanHost(String host) {
        int nul = host.indexOf('\0');
        if (nul >= 0) host = host.substring(0, nul);
        if (host.endsWith(".")) host = host.substring(0, host.length() - 1);
        return host;
    }

    private boolean isVerifierHost(String host) {
        return cleanHost(host).toLowerCase().startsWith(hostPrefix);
    }

    /** Where to send the player back to: the configured address, else the host they used minus the verifier prefix. */
    private String[] returnAddress() {
        if (!returnOverride.isBlank()) {
            int i = returnOverride.lastIndexOf(':');
            return new String[] {returnOverride.substring(0, i), returnOverride.substring(i + 1)};
        }
        String host = hostSeen.toLowerCase().startsWith(hostPrefix) ? hostSeen.substring(hostPrefix.length()) : hostSeen;
        return new String[] {host, Integer.toString(portSeen)};
    }

    private void passThroughRaw(ChannelHandlerContext ctx) {
        byte[] all = raw;
        raw = new byte[0];
        ctx.fireChannelRead(Unpooled.wrappedBuffer(all));
        ctx.pipeline().remove(this);
    }

    private void passThrough(ChannelHandlerContext ctx, Object msg) {
        if (raw.length > 0) {
            byte[] all = raw;
            raw = new byte[0];
            ctx.fireChannelRead(Unpooled.wrappedBuffer(all));
        }
        ctx.fireChannelRead(msg);
        ctx.pipeline().remove(this);
    }

    // --- phase 2: our own login handshake ---

    private void takeOver(ChannelHandlerContext ctx, byte[] rest) {
        String ip = ctx.channel().remoteAddress() instanceof InetSocketAddress a ? a.getAddress().getHostAddress() : "?";
        if (!limits.tryAcquire(ip)) {
            ctx.close();
            return;
        }
        limitedIp = ip;
        raw = new byte[0];
        state = State.LOGIN;
        buf = rest;
        ctx.executor().schedule(() -> { ctx.close(); }, TIMEOUT_SECONDS, TimeUnit.SECONDS);
        try {
            drain(ctx);
        } catch (Exception e) {
            ctx.close();
        }
    }

    private void drain(ChannelHandlerContext ctx) throws Exception {
        while (state != State.VERIFYING && state != State.DONE) {
            int[] len = McProtocol.readVarInt(buf, 0);
            if (len == null) return;
            if (len[0] <= 0 || len[0] > MAX_PACKET) throw new IllegalArgumentException("bad length");
            int total = len[1] + len[0];
            if (buf.length < total) return;
            McProtocol.Reader r = new McProtocol.Reader(buf, len[1]);
            int id = r.varInt();
            byte[] rest = Arrays.copyOfRange(buf, total, buf.length);
            handle(ctx, id, r);
            // Bytes that followed the encryption response were already encrypted by the client.
            if (cipherJustEnabled) {
                rest = rest.length > 0 ? decrypt.update(rest) : rest;
                cipherJustEnabled = false;
            }
            buf = rest;
        }
        if (state == State.VERIFYING || state == State.DONE) buf = new byte[0]; // nothing is expected from the client now
    }

    private void handle(ChannelHandlerContext ctx, int id, McProtocol.Reader r) throws Exception {
        if (state == State.LOGIN && id == 0) {
            playerName = r.string(16);
            if (!playerName.matches("[A-Za-z0-9_]{1,16}")) throw new IllegalArgumentException("bad name");
            verifyToken = new byte[4];
            RANDOM.nextBytes(verifyToken);
            ByteArrayOutputStream body = new ByteArrayOutputStream();
            McProtocol.writeString(body, ""); // server id is empty, as in vanilla
            McProtocol.writeBytes(body, publicDer);
            McProtocol.writeBytes(body, verifyToken);
            body.write(1); // should authenticate: the client proves itself to Mojang
            state = State.ENCRYPTING;
            write(ctx, McProtocol.frame(1, body.toByteArray()));
        } else if (state == State.ENCRYPTING && id == 1) {
            byte[] secret = rsaDecrypt(r.byteArray(512));
            byte[] token = rsaDecrypt(r.byteArray(512));
            // A wrong secret size and a wrong token look identical to the peer.
            if (secret == null || secret.length != 16 || token == null || !MessageEqual.equal(token, verifyToken)) throw new IllegalArgumentException("bad key exchange");
            encrypt = Cipher.getInstance("AES/CFB8/NoPadding");
            encrypt.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(secret, "AES"), new IvParameterSpec(secret));
            decrypt = Cipher.getInstance("AES/CFB8/NoPadding");
            decrypt.init(Cipher.DECRYPT_MODE, new SecretKeySpec(secret, "AES"), new IvParameterSpec(secret));
            cipherJustEnabled = true;
            serverHashValue = McProtocol.serverHash(new byte[0], secret, publicDer);
            if (protocol >= COOKIES_FROM_PROTOCOL) {
                // Ask the client for the cookie /premium stored (travels encrypted). No cookie = manual connect.
                ByteArrayOutputStream body = new ByteArrayOutputStream();
                McProtocol.writeString(body, PREMIUM_COOKIE);
                state = State.COOKIE;
                write(ctx, McProtocol.frame(5, body.toByteArray())); // Cookie Request (login)
            } else {
                startVerification(ctx);
            }
        } else if (state == State.COOKIE && id == 4) {
            String key = r.string(256);
            boolean present = r.bytes(1)[0] == 1;
            String value = present ? new String(r.byteArray(5120), java.nio.charset.StandardCharsets.UTF_8) : null;
            // Anything that is not our cookie in our token format is treated as "no cookie".
            premiumToken = key.equals(PREMIUM_COOKIE) && value != null && value.matches("[A-Za-z0-9_-]{16,128}") ? value : null;
            startVerification(ctx);
        } else if (state == State.ACK_WAIT && id == 3) {
            sendTransferBack(ctx);
        } else {
            throw new IllegalArgumentException("unexpected packet " + id + " in " + state);
        }
    }

    private String serverHashValue;

    private void startVerification(ChannelHandlerContext ctx) {
        state = State.VERIFYING;
        String name = playerName;
        String hash = serverHashValue;
        String token = premiumToken;
        String ip = limitedIp;
        String host = hostSeen + ":" + portSeen;
        async.execute(() -> {
            Outcome outcome;
            try {
                outcome = verifier.verify(name, hash, token, ip, host);
            } catch (Exception e) {
                log.warning("premium verification failed for " + name + ": " + e);
                outcome = Outcome.message(FAILURE);
            }
            Outcome result = outcome;
            ctx.executor().execute(() -> onVerified(ctx, result));
        });
    }

    private void onVerified(ChannelHandlerContext ctx, Outcome outcome) {
        if (outcome.sessionToken() == null) {
            disconnect(ctx, outcome.message());
            return;
        }
        // Finish the login properly: only after Login Success and the client's acknowledgement is the connection in
        // the configuration state, where Store Cookie and Transfer are allowed.
        returnToken = outcome.sessionToken();
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        body.writeBytes(uuidBytes(outcome.mojangUuid()));
        McProtocol.writeString(body, outcome.mojangName());
        McProtocol.writeVarInt(body, 0); // no profile properties
        if (protocol >= SESSION_ID_FROM_PROTOCOL) {
            byte[] sessionId = new byte[16];
            RANDOM.nextBytes(sessionId);
            body.writeBytes(sessionId);
        }
        state = State.ACK_WAIT;
        write(ctx, McProtocol.frame(2, body.toByteArray())); // Login Success
    }

    private void sendTransferBack(ChannelHandlerContext ctx) {
        String[] back = returnAddress();
        ByteArrayOutputStream cookie = new ByteArrayOutputStream();
        McProtocol.writeString(cookie, SESSION_COOKIE);
        McProtocol.writeBytes(cookie, returnToken.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        ByteArrayOutputStream transfer = new ByteArrayOutputStream();
        McProtocol.writeString(transfer, back[0]);
        McProtocol.writeVarInt(transfer, Integer.parseInt(back[1]));
        state = State.DONE;
        byte[] out = McProtocol.concat(
                encrypt.update(McProtocol.frame(0x0B, cookie.toByteArray())), // Store Cookie (configuration)
                encrypt.update(McProtocol.frame(0x0C, transfer.toByteArray()))); // Transfer (configuration)
        // The client closes the connection itself on Transfer; close ours shortly after as a backstop.
        ctx.writeAndFlush(Unpooled.wrappedBuffer(out)).addListener(f -> ctx.executor().schedule(() -> { ctx.close(); }, 2, TimeUnit.SECONDS));
    }

    private static byte[] uuidBytes(String hex32) {
        byte[] out = new byte[16];
        for (int i = 0; i < 16; i++) out[i] = (byte) Integer.parseInt(hex32.substring(i * 2, i * 2 + 2), 16);
        return out;
    }

    private byte[] rsaDecrypt(byte[] data) {
        try {
            Cipher c = Cipher.getInstance("RSA/ECB/PKCS1Padding");
            c.init(Cipher.DECRYPT_MODE, keys.getPrivate());
            return c.doFinal(data);
        } catch (Exception e) {
            return null; // never distinguish padding errors from other failures
        }
    }

    private void write(ChannelHandlerContext ctx, byte[] packet) {
        byte[] out = encrypt != null ? encrypt.update(packet) : packet;
        ctx.writeAndFlush(Unpooled.wrappedBuffer(out));
    }

    private void disconnect(ChannelHandlerContext ctx, String message) {
        JsonObject text = new JsonObject();
        text.addProperty("text", message); // Disconnect (login) takes a JSON text component
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        McProtocol.writeString(body, text.toString());
        byte[] packet = McProtocol.frame(0, body.toByteArray());
        ctx.writeAndFlush(Unpooled.wrappedBuffer(encrypt.update(packet))).addListener(ChannelFutureListener.CLOSE);
    }

    @Override
    public void channelInactive(ChannelHandlerContext ctx) throws Exception {
        if (limitedIp != null) {
            limits.release(limitedIp);
            limitedIp = null;
        }
        super.channelInactive(ctx);
    }

    @Override
    public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) {
        ctx.close();
    }

    private static byte[] concat(byte[] a, byte[] b) {
        if (a.length == 0) return b;
        byte[] out = new byte[a.length + b.length];
        System.arraycopy(a, 0, out, 0, a.length);
        System.arraycopy(b, 0, out, a.length, b.length);
        return out;
    }

    /** Constant-time comparison (MessageDigest.isEqual is the standard way). */
    private static final class MessageEqual {
        static boolean equal(byte[] a, byte[] b) {
            return java.security.MessageDigest.isEqual(a, b);
        }
    }
}
