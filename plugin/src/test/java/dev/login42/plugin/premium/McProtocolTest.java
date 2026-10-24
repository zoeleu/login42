package dev.login42.plugin.premium;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

class McProtocolTest {
    private static byte[] ascii(String s) {
        return s.getBytes(StandardCharsets.US_ASCII);
    }

    // The three examples from https://minecraft.wiki/w/Java_Edition_protocol/Encryption
    @Test
    void serverHashMatchesWikiExamples() {
        assertEquals("4ed1f46bbe04bc756bcb17c0c7ce3e4632f06a48", McProtocol.serverHash(ascii("Notch")));
        assertEquals("-7c9d5b0044c130109a5d7b5fb5c317c02b4e28c1", McProtocol.serverHash(ascii("jeb_")));
        assertEquals("88e16a1019277b15d58faf0541e11910eb756f6", McProtocol.serverHash(ascii("simon")));
    }

    @Test
    void varIntRoundTripAndPartialInput() {
        for (int n : new int[] {0, 1, 127, 128, 255, 25565, 2097151, Integer.MAX_VALUE}) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            McProtocol.writeVarInt(out, n);
            int[] r = McProtocol.readVarInt(out.toByteArray(), 0);
            assertEquals(n, r[0]);
            assertEquals(out.size(), r[1]);
        }
        assertNull(McProtocol.readVarInt(new byte[] {(byte) 0x80}, 0), "a continuation byte without the next one means: wait for more");
        assertThrows(IllegalArgumentException.class, () -> McProtocol.readVarInt(new byte[] {(byte) 0x80, (byte) 0x80, (byte) 0x80, (byte) 0x80, (byte) 0x80, 1}, 0));
    }

    @Test
    void frameAndReader() {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        McProtocol.writeString(body, "ProbeBot");
        byte[] f = McProtocol.frame(0, body.toByteArray());
        int[] len = McProtocol.readVarInt(f, 0);
        assertEquals(f.length - len[1], len[0]);
        McProtocol.Reader r = new McProtocol.Reader(f, len[1]);
        assertEquals(0, r.varInt());
        assertEquals("ProbeBot", r.string(16));
        assertEquals(0, r.remaining());
        assertThrows(IllegalArgumentException.class, () -> r.bytes(1));
        assertArrayEquals(new byte[0], r.bytes(0));
    }
}
