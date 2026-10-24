package dev.login42.plugin;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Fresh signed textures for a Mojang account, fetched from this machine (the web service cannot: Mojang answers HTTP 403
 * to Cloudflare Workers). Cached briefly so joins do not hammer Mojang; a failure just means the caller uses the stored snapshot.
 */
public final class MojangProfiles {
    public record Textures(String value, String signature) {}

    private record Cached(Optional<Textures> textures, long at) {}

    private static final long TTL_MS = 60_000L;
    private static final long FAILURE_BACKOFF_MS = 2 * 60_000L;

    private final HttpClient http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).connectTimeout(Duration.ofSeconds(3)).build();
    private final Map<String, Cached> cache = new ConcurrentHashMap<>();
    private final String baseUrl;
    private final java.util.function.LongSupplier clock;

    /** baseUrl ends with a slash; the uuid and "?unsigned=false" are appended. */
    public MojangProfiles(String baseUrl) {
        this(baseUrl, System::currentTimeMillis);
    }

    MojangProfiles(String baseUrl, java.util.function.LongSupplier clock) {
        this.baseUrl = baseUrl;
        this.clock = clock;
    }

    /** Blocking. Returns empty if Mojang has no signed textures or could not be reached. */
    public Optional<Textures> fresh(String mojangUuid) {
        String id = mojangUuid.replace("-", "").toLowerCase();
        if (!id.matches("[0-9a-f]{32}")) return Optional.empty();
        long now = clock.getAsLong();
        Cached c = cache.get(id);
        if (c != null && now - c.at() < (c.textures().isPresent() ? TTL_MS : FAILURE_BACKOFF_MS)) return c.textures();
        Optional<Textures> result = Optional.empty();
        try {
            HttpResponse<String> res = http.send(HttpRequest.newBuilder(URI.create(baseUrl + id + "?unsigned=false")).timeout(Duration.ofSeconds(4)).GET().build(), HttpResponse.BodyHandlers.ofString());
            if (res.statusCode() == 200) result = parse(res.body());
        } catch (IOException e) {
            // unreachable: fall back to the snapshot
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (RuntimeException e) {
            // A malformed upstream response must not break login or the refresh worker.
        }
        if (cache.size() > 512) cache.values().removeIf(v -> now - v.at() >= TTL_MS);
        cache.put(id, new Cached(result, now));
        return result;
    }

    static Optional<Textures> parse(String json) {
        JsonObject o = new Gson().fromJson(json, JsonObject.class);
        if (o == null || !o.has("properties") || !o.get("properties").isJsonArray()) return Optional.empty();
        for (var e : o.getAsJsonArray("properties")) {
            JsonObject p = e.getAsJsonObject();
            if (p.has("name") && "textures".equals(p.get("name").getAsString()) && p.has("value") && p.has("signature")) {
                return Optional.of(new Textures(p.get("value").getAsString(), p.get("signature").getAsString()));
            }
        }
        return Optional.empty();
    }
}
