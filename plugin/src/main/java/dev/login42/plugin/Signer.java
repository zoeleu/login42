package dev.login42.plugin;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Signs requests as HMAC-SHA256(secret, "{ts}.{METHOD}.{path}.{body}"), matching the web service. */
final class Signer {
    private final byte[] secret;

    Signer(String secret) {
        this.secret = secret.getBytes(StandardCharsets.UTF_8);
    }

    String sign(String timestampMs, String method, String path, String body) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret, "HmacSHA256"));
            String message = timestampMs + "." + method.toUpperCase() + "." + path + "." + body;
            return HexFormat.of().formatHex(mac.doFinal(message.getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }
}
