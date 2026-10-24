-- Browser sessions for the /me pages (skin upload, premium linking).
CREATE TABLE web_sessions (
  id_hash    TEXT PRIMARY KEY,
  ft_id      INTEGER NOT NULL REFERENCES users(ft_id),
  expires_at INTEGER NOT NULL
);

-- Issued by the verifier after a real Mojang online-mode login; the player enters it on /me to link.
CREATE TABLE premium_proofs (
  code        TEXT PRIMARY KEY,
  mojang_uuid TEXT NOT NULL,
  mojang_name TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);

-- Short-lived cache of Mojang's signed textures per Mojang UUID.
CREATE TABLE mojang_cache (
  mojang_uuid TEXT PRIMARY KEY,
  value       TEXT,
  signature   TEXT,
  fetched_at  INTEGER NOT NULL
);
