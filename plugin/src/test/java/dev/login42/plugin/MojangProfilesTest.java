package dev.login42.plugin;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class MojangProfilesTest {
    private static final String ID = "069a79f444e94726a5befca90e38aaf5";

    private static HttpServer server(int status, String body, AtomicInteger hits) throws Exception {
        HttpServer s = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        s.createContext("/profile/", ex -> {
            hits.incrementAndGet();
            byte[] b = body.getBytes(StandardCharsets.UTF_8);
            ex.sendResponseHeaders(status, b.length == 0 ? -1 : b.length);
            if (b.length > 0) ex.getResponseBody().write(b);
            ex.close();
        });
        s.start();
        return s;
    }

    @Test
    void parsesSignedTexturesAndCachesThem() throws Exception {
        AtomicInteger hits = new AtomicInteger();
        HttpServer s = server(200, "{\"id\":\"" + ID + "\",\"name\":\"Notch\",\"properties\":[{\"name\":\"textures\",\"value\":\"V\",\"signature\":\"S\"}]}", hits);
        try {
            MojangProfiles p = new MojangProfiles("http://127.0.0.1:" + s.getAddress().getPort() + "/profile/");
            assertEquals(new MojangProfiles.Textures("V", "S"), p.fresh(ID).orElseThrow());
            p.fresh(ID);
            assertEquals(1, hits.get(), "second call is served from the cache");
        } finally {
            s.stop(0);
        }
    }

    @Test
    void unsignedOrFailedLookupsFallBackAndBackOff() throws Exception {
        AtomicInteger hits = new AtomicInteger();
        HttpServer s = server(403, "", hits);
        try {
            MojangProfiles p = new MojangProfiles("http://127.0.0.1:" + s.getAddress().getPort() + "/profile/");
            assertTrue(p.fresh(ID).isEmpty(), "a 403 means: use the stored snapshot");
            p.fresh(ID);
            assertEquals(1, hits.get(), "failures are not retried immediately");
            assertTrue(p.fresh("not-a-uuid").isEmpty());
        } finally {
            s.stop(0);
        }
        assertTrue(MojangProfiles.parse("{\"properties\":[{\"name\":\"textures\",\"value\":\"V\"}]}").isEmpty(), "an unsigned property is ignored");
    }

    @Test
    void pollsAgainAfterOneMinuteRatherThanKeepingTenMinuteOldSkins() throws Exception {
        AtomicInteger hits = new AtomicInteger();
        var clock = new java.util.concurrent.atomic.AtomicLong(1_000_000);
        HttpServer s = server(200, "{\"properties\":[{\"name\":\"textures\",\"value\":\"V\",\"signature\":\"S\"}]}", hits);
        try {
            MojangProfiles p = new MojangProfiles("http://127.0.0.1:" + s.getAddress().getPort() + "/profile/", clock::get);
            p.fresh(ID);
            clock.addAndGet(59_000); p.fresh(ID);
            assertEquals(1, hits.get());
            clock.addAndGet(1_001); p.fresh(ID);
            assertEquals(2, hits.get());
        } finally { s.stop(0); }
    }
}
