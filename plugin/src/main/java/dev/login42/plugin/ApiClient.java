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

/** Blocking client for the web service; call from async threads only. */
public final class ApiClient {
    record Skin(String value, String signature, String mojangUuid) {}
    record JoinResult(String status, String uuid, String name, String token, String code, String url, String reason, Skin skin, String specialTitle, String auditId, String auditHash) {}
    record LimboPoll(String status, String token) {}
    record ServerBan(String uuid, String name, String reason) {}
    record SkinState(String uuid, String kind, String mojangUuid, String value, String signature) {}

    private final HttpClient http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build();
    private final Gson gson = new Gson();
    private final String baseUrl;
    private final Signer signer;
    private final Duration timeout;

    ApiClient(String baseUrl, String secret, int timeoutSeconds) {
        this.baseUrl = baseUrl;
        this.signer = new Signer(secret);
        this.timeout = Duration.ofSeconds(timeoutSeconds);
    }

    /** token is the session cookie the client presented, or null. clientUuid and host are recorded for audit only. */
    JoinResult joinCheck(String name, String clientUuid, String token, String ip, String host) throws IOException, InterruptedException {
        Map<String, Object> body = new java.util.HashMap<>();
        body.put("name", name);
        body.put("client_uuid", clientUuid);
        body.put("token", token);
        body.put("ip", ip);
        body.put("host", host);
        JsonObject o = gson.fromJson(send("POST", "/api/v1/join-check", gson.toJson(body)), JsonObject.class);
        Skin skin = null;
        if (o.has("skin") && o.get("skin").isJsonObject()) {
            JsonObject sk = o.getAsJsonObject("skin");
            if (str(sk, "value") != null && str(sk, "signature") != null) skin = new Skin(str(sk, "value"), str(sk, "signature"), str(sk, "mojang_uuid"));
        }
        return new JoinResult(str(o, "status"), str(o, "uuid"), str(o, "name"), str(o, "token"), str(o, "code"), str(o, "url"), str(o, "reason"), skin, str(o, "special_title"), str(o, "audit_id"), str(o, "audit_hash"));
    }

    LimboPoll pollLimbo(String code) throws IOException, InterruptedException {
        JsonObject o = gson.fromJson(send("GET", "/api/v1/limbo/" + code, ""), JsonObject.class);
        return new LimboPoll(str(o, "status"), str(o, "token"));
    }

    java.util.List<SkinState> skinStates(java.util.List<String> uuids) throws IOException, InterruptedException {
        JsonObject o = gson.fromJson(send("POST", "/api/v1/skins", gson.toJson(Map.of("uuids", uuids))), JsonObject.class);
        if (!o.has("skins") || !o.get("skins").isJsonArray()) throw new IOException("Missing skin refresh response");
        java.util.List<SkinState> result = new java.util.ArrayList<>();
        for (var entry : o.getAsJsonArray("skins")) {
            JsonObject s = entry.getAsJsonObject();
            result.add(new SkinState(str(s, "uuid"), str(s, "kind"), str(s, "mojang_uuid"), str(s, "value"), str(s, "signature")));
        }
        return result;
    }

    java.util.List<ServerBan> listBans() throws IOException, InterruptedException {
        JsonObject o = gson.fromJson(send("GET", "/api/v1/bans", ""), JsonObject.class);
        java.util.List<ServerBan> out = new java.util.ArrayList<>();
        if (o != null && o.has("bans")) {
            for (var e : o.getAsJsonArray("bans")) {
                JsonObject b = e.getAsJsonObject();
                out.add(new ServerBan(str(b, "mc_uuid"), str(b, "mc_name"), str(b, "reason")));
            }
        }
        return out;
    }

    /** Asks the web service for a one-time code proving this Mojang account was verified by the server. */
    /** Result of binding a verified Mojang account to the 42 user who asked for it in game. */
    public record BindResult(boolean ok, String login, String sessionToken, String error) {}

    /** /premium: a signed-in player asks for a one-time token to carry to the verifier in a cookie. */
    public String premiumStart(String mcUuid) throws IOException, InterruptedException {
        JsonObject o = gson.fromJson(send("POST", "/api/v1/premium/start", gson.toJson(Map.of("mc_uuid", mcUuid))), JsonObject.class);
        String token = str(o, "token");
        if (token == null) throw new IOException("no premium token returned");
        return token;
    }

    /** The verifier reports a Mojang login it checked itself, with the token from the player's cookie. */
    public BindResult premiumBind(String token, String mojangUuid, String mojangName, String textureValue, String textureSignature, String ip, String host) throws IOException, InterruptedException {
        Map<String, Object> fields = new java.util.HashMap<>(Map.of("token", token, "mojang_uuid", mojangUuid, "mojang_name", mojangName, "ip", ip, "host", host));
        if (textureValue != null && textureSignature != null) fields.put("textures", Map.of("value", textureValue, "signature", textureSignature));
        String body = gson.toJson(fields);
        String path = "/api/v1/premium/bind";
        String ts = Long.toString(System.currentTimeMillis());
        HttpRequest req = HttpRequest.newBuilder(URI.create(baseUrl + path))
                .timeout(timeout)
                .header("content-type", "application/json")
                .header("x-timestamp", ts)
                .header("x-signature", signer.sign(ts, "POST", path, body))
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();
        HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
        JsonObject o = gson.fromJson(res.body(), JsonObject.class);
        if (res.statusCode() == 200 && o != null) return new BindResult(true, str(o, "login"), str(o, "session_token"), null);
        return new BindResult(false, null, null, o != null ? str(o, "error") : "HTTP " + res.statusCode());
    }

    /** Returning premium login: the caller must first verify ownership with Mojang hasJoined. */
    public BindResult premiumLogin(String mojangUuid, String mojangName, String ip, String host) throws IOException, InterruptedException {
        String path = "/api/v1/premium/login";
        String body = gson.toJson(Map.of("mojang_uuid", mojangUuid, "mojang_name", mojangName, "ip", ip, "host", host));
        String ts = Long.toString(System.currentTimeMillis());
        HttpRequest req = HttpRequest.newBuilder(URI.create(baseUrl + path)).timeout(timeout)
                .header("content-type", "application/json").header("x-timestamp", ts)
                .header("x-signature", signer.sign(ts, "POST", path, body))
                .POST(HttpRequest.BodyPublishers.ofString(body)).build();
        HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
        JsonObject o = gson.fromJson(res.body(), JsonObject.class);
        return res.statusCode() == 200 && o != null
                ? new BindResult(true, str(o, "login"), str(o, "session_token"), null)
                : new BindResult(false, null, null, o != null ? str(o, "error") : "HTTP " + res.statusCode());
    }

    /** Routing hints only: a listed UUID still has to prove ownership with Mojang on every connection. */
    public java.util.Set<String> premiumAccounts() throws IOException, InterruptedException {
        JsonObject o = gson.fromJson(send("GET", "/api/v1/premium/accounts", ""), JsonObject.class);
        java.util.Set<String> ids = new java.util.HashSet<>();
        if (o.has("accounts")) for (var id : o.getAsJsonArray("accounts")) {
            String value = id.getAsString().toLowerCase(java.util.Locale.ROOT);
            if (value.matches("[0-9a-f]{32}")) ids.add(value);
        }
        return java.util.Set.copyOf(ids);
    }

    public String premiumProof(String mojangUuid, String mojangName, String ip, String host) throws IOException, InterruptedException {
        JsonObject o = gson.fromJson(send("POST", "/api/v1/premium/proof", gson.toJson(Map.of("mojang_uuid", mojangUuid, "mojang_name", mojangName, "ip", ip, "host", host))), JsonObject.class);
        String code = str(o, "code");
        if (code == null) throw new IOException("no proof code returned");
        return code;
    }

    void ban(String uuid, String reason, String source) throws IOException, InterruptedException {
        send("POST", "/api/v1/bans", gson.toJson(Map.of("mc_uuid", uuid, "reason", reason == null ? "" : reason, "source", source == null ? "" : source)));
    }

    void pardon(String uuid, String source) throws IOException, InterruptedException {
        send("POST", "/api/v1/pardons", gson.toJson(Map.of("mc_uuid", uuid, "source", source)));
    }

    private static String str(JsonObject o, String key) {
        return o.has(key) && !o.get(key).isJsonNull() ? o.get(key).getAsString() : null;
    }

    private String send(String method, String path, String body) throws IOException, InterruptedException {
        String ts = Long.toString(System.currentTimeMillis());
        HttpRequest req = HttpRequest.newBuilder(URI.create(baseUrl + path))
                .timeout(timeout)
                .header("content-type", "application/json")
                .header("x-timestamp", ts)
                .header("x-signature", signer.sign(ts, method, path, body))
                .method(method, HttpRequest.BodyPublishers.ofString(body))
                .build();
        HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
        if (res.statusCode() == 404) return "{}"; // not a 42-linked uuid: nothing to sync
        if (res.statusCode() / 100 != 2) throw new IOException(method + " " + path + " -> HTTP " + res.statusCode());
        return res.body();
    }
}
