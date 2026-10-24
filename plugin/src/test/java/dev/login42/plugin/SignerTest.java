package dev.login42.plugin;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class SignerTest {
    // Expected value produced independently with Node's crypto.createHmac, same scheme as the web service.
    @Test
    void matchesServerSigningScheme() {
        String sig = new Signer("s3cret").sign("1700000000000", "post", "/api/v1/join-check", "{\"a\":1}");
        assertEquals("c44de34047ed5661d309ee5af40802e8436220533e4e14982c0af1374798df0c", sig);
    }
}
