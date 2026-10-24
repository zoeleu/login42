package dev.login42.plugin.premium;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

/** Mojang's hasJoined check: did this client just tell Mojang it is joining a server with this hash? */
final class SessionServer {
    record Profile(String uuid, String name, String textureValue, String textureSignature) {}

    private final HttpClient http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build();
    private final String baseUrl;

    SessionServer(String baseUrl) {
        this.baseUrl = baseUrl;
    }

    /** Returns the verified profile, or null if Mojang does not confirm it (HTTP 204). Blocking. */
    Profile hasJoined(String username, String serverHash) throws IOException, InterruptedException {
        String q = "?username=" + URLEncoder.encode(username, StandardCharsets.UTF_8) + "&serverId=" + URLEncoder.encode(serverHash, StandardCharsets.UTF_8);
        HttpResponse<String> res = http.send(HttpRequest.newBuilder(URI.create(baseUrl + q)).timeout(Duration.ofSeconds(8)).GET().build(), HttpResponse.BodyHandlers.ofString());
        if (res.statusCode() != 200) return null;
        JsonObject o = new Gson().fromJson(res.body(), JsonObject.class);
        if (o == null || !o.has("id") || !o.has("name")) return null;
        String id = o.get("id").getAsString();
        if (!id.matches("[0-9a-fA-F]{32}")) return null;
        // The reply carries Mojang's signed textures for this account; keep them as a snapshot.
        String value = null;
        String signature = null;
        if (o.has("properties") && o.get("properties").isJsonArray()) {
            for (var e : o.getAsJsonArray("properties")) {
                JsonObject prop = e.getAsJsonObject();
                if (prop.has("name") && "textures".equals(prop.get("name").getAsString()) && prop.has("signature")) {
                    value = prop.get("value").getAsString();
                    signature = prop.get("signature").getAsString();
                }
            }
        }
        return new Profile(id.toLowerCase(), o.get("name").getAsString(), value, signature);
    }
}
