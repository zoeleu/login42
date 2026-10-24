CREATE TABLE users (
  ft_id      INTEGER PRIMARY KEY,
  login      TEXT NOT NULL,
  uuid       TEXT NOT NULL UNIQUE,
  mc_name    TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at INTEGER NOT NULL
);

CREATE TABLE bans (
  ft_id      INTEGER PRIMARY KEY REFERENCES users(ft_id),
  reason     TEXT,
  source     TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  ft_id      INTEGER NOT NULL REFERENCES users(ft_id),
  ip_hash    TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_lookup ON sessions(ft_id, ip_hash, expires_at);

CREATE TABLE link_codes (
  code       TEXT PRIMARY KEY,
  mc_name    TEXT NOT NULL,
  ip_hash    TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE oauth_states (
  state      TEXT PRIMARY KEY,
  link_code  TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Skin source per person; premium ownership is only ever set by the verifier (see plan).
CREATE TABLE skin_source (
  ft_id       INTEGER PRIMARY KEY REFERENCES users(ft_id),
  kind        TEXT NOT NULL CHECK (kind IN ('mojang','upload','default')),
  mojang_uuid TEXT UNIQUE,
  value       TEXT,
  signature   TEXT,
  verified_at INTEGER,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  ft_id  INTEGER,
  action TEXT NOT NULL,
  detail TEXT
);
