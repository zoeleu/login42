package dev.login42.plugin;

import static org.junit.jupiter.api.Assertions.*;
import com.destroystokyo.paper.profile.ProfileProperty;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import org.junit.jupiter.api.Test;

class SkinSyncTest {
    private static ProfileProperty texture(String json) {
        return new ProfileProperty("textures", Base64.getEncoder().encodeToString(json.getBytes(StandardCharsets.UTF_8)), "signature");
    }

    @Test
    void ignoresMojangTimestampsAndJsonKeyOrderForUnchangedSkins() {
        var a = texture("{\"timestamp\":1,\"textures\":{\"SKIN\":{\"url\":\"skin-a\",\"metadata\":{\"model\":\"slim\"}}}}");
        var b = texture("{\"timestamp\":2,\"textures\":{\"SKIN\":{\"metadata\":{\"model\":\"slim\"},\"url\":\"skin-a\"}}}");
        assertEquals(SkinSync.fingerprint(a), SkinSync.fingerprint(b));
    }

    @Test
    void detectsSkinModelCapeAndDefaultChanges() {
        var original = texture("{\"textures\":{\"SKIN\":{\"url\":\"skin-a\"}}}");
        for (String changed : new String[] {
                "{\"textures\":{\"SKIN\":{\"url\":\"skin-b\"}}}",
                "{\"textures\":{\"SKIN\":{\"url\":\"skin-a\",\"metadata\":{\"model\":\"slim\"}}}}",
                "{\"textures\":{\"SKIN\":{\"url\":\"skin-a\"},\"CAPE\":{\"url\":\"cape\"}}}" }) {
            assertNotEquals(SkinSync.fingerprint(original), SkinSync.fingerprint(texture(changed)));
        }
        assertNotEquals(SkinSync.fingerprint(original), SkinSync.fingerprint(null));
        assertDoesNotThrow(() -> SkinSync.fingerprint(new ProfileProperty("textures", "not-base64", "signature")));
    }

    @Test
    void usesOnlySignedUploadsAndKeepsMojangFailuresSeparateFromDefaultReset() {
        var upload = new ApiClient.SkinState("uuid", "upload", null, "value", "signature");
        assertEquals("value", SkinSync.resolve(upload, null, true).getValue());
        assertNull(SkinSync.resolve(new ApiClient.SkinState("uuid", "upload", null, "value", null), null, true));
        assertNull(SkinSync.resolve(new ApiClient.SkinState("uuid", "default", null, null, null), null, true));
        // Invalid Mojang id returns empty without a network request; never revert to its stale snapshot.
        var mojang = new ApiClient.SkinState("uuid", "mojang", "invalid-id", "old-value", "old-signature");
        assertNull(SkinSync.resolve(mojang, new MojangProfiles("http://127.0.0.1/"), true));
        assertNull(SkinSync.resolve(mojang, null, false));
    }
}
