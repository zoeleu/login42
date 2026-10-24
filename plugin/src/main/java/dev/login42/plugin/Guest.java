package dev.login42.plugin;

/** A connection admitted to limbo until it proves a 42 identity. */
record Guest(String code, String url, String transferHost, int transferPort, String ip, long createdAt) {
    Guest(String code, String url, String transferHost, int transferPort, String ip) {
        this(code, url, transferHost, transferPort, ip, System.currentTimeMillis());
    }
}
