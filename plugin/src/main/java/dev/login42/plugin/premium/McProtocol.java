package dev.login42.plugin.premium;

import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/** The few pieces of the Java protocol the premium handshake needs (https://minecraft.wiki/w/Java_Edition_protocol/Encryption). */
final class McProtocol {
    private McProtocol() {}

    /** Reads a VarInt at {@code off}; returns {value, size} or null if more bytes are needed. Throws on malformed input. */
    static int[] readVarInt(byte[] b, int off) {
        int value = 0;
        for (int i = 0; i < 5; i++) {
            if (off + i >= b.length) return null;
            int x = b[off + i];
            value |= (x & 0x7f) << (7 * i);
            if ((x & 0x80) == 0) return new int[] {value, i + 1};
        }
        throw new IllegalArgumentException("VarInt too long");
    }

    static void writeVarInt(ByteArrayOutputStream out, int n) {
        do {
            int b = n & 0x7f;
            n >>>= 7;
            out.write(n != 0 ? b | 0x80 : b);
        } while (n != 0);
    }

    static void writeString(ByteArrayOutputStream out, String s) {
        byte[] b = s.getBytes(StandardCharsets.UTF_8);
        writeVarInt(out, b.length);
        out.writeBytes(b);
    }

    static void writeBytes(ByteArrayOutputStream out, byte[] b) {
        writeVarInt(out, b.length);
        out.writeBytes(b);
    }

    static byte[] concat(byte[]... parts) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (byte[] p : parts) out.writeBytes(p);
        return out.toByteArray();
    }

    /** One framed packet: length, id, body. */
    static byte[] frame(int id, byte[] body) {
        ByteArrayOutputStream payload = new ByteArrayOutputStream();
        writeVarInt(payload, id);
        payload.writeBytes(body);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        writeVarInt(out, payload.size());
        out.writeBytes(payload.toByteArray());
        return out.toByteArray();
    }

    /**
     * Minecraft's "server hash": SHA-1 of serverId, shared secret and DER public key, printed as a signed
     * two's-complement hex integer, which is exactly BigInteger's toString(16).
     */
    static String serverHash(byte[]... parts) {
        try {
            MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
            for (byte[] p : parts) sha1.update(p);
            return new BigInteger(sha1.digest()).toString(16);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Sequential reader over one packet body; throws on truncation so malformed input closes the connection. */
    static final class Reader {
        private final byte[] buf;
        private int pos;

        Reader(byte[] buf, int pos) {
            this.buf = buf;
            this.pos = pos;
        }

        int varInt() {
            int[] r = readVarInt(buf, pos);
            if (r == null) throw new IllegalArgumentException("truncated");
            pos += r[1];
            return r[0];
        }

        byte[] bytes(int n) {
            if (n < 0 || pos + n > buf.length) throw new IllegalArgumentException("truncated");
            byte[] out = new byte[n];
            System.arraycopy(buf, pos, out, 0, n);
            pos += n;
            return out;
        }

        String string(int maxChars) {
            int n = varInt();
            if (n > maxChars * 4) throw new IllegalArgumentException("string too long");
            return new String(bytes(n), StandardCharsets.UTF_8);
        }

        byte[] byteArray(int max) {
            int n = varInt();
            if (n > max) throw new IllegalArgumentException("array too long");
            return bytes(n);
        }

        int remaining() {
            return buf.length - pos;
        }

        void skip(int n) {
            bytes(Math.min(n, remaining()));
        }
    }
}
