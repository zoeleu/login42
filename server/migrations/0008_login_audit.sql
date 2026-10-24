-- Append-only, hash-chained record of authentications, kept for abuse investigations.
-- Each row's hash = SHA-256(prev_hash || "\n" || canonical JSON of its fields); see src/lib/audit.ts.
-- No foreign keys: records must outlive account deletion. UNIQUE(prev_hash) keeps the chain linear.
-- token_hash is the SHA-256 of a one-use handoff token, never the token: it correlates issuance with use
-- but cannot be presented to log in.
CREATE TABLE login_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  event       TEXT NOT NULL,
  ft_id       INTEGER,
  login       TEXT,
  mc_uuid     TEXT,
  ip          TEXT,
  ip_source   TEXT,
  client_name TEXT,
  client_uuid TEXT,
  mojang_uuid TEXT,
  mojang_name TEXT,
  token_hash  TEXT,
  host        TEXT,
  user_agent  TEXT,
  detail      TEXT,
  prev_hash   TEXT NOT NULL UNIQUE,
  hash        TEXT NOT NULL UNIQUE,
  -- Set when retention ends: personal columns are cleared, while id/at/event/prev_hash/hash stay so the
  -- remaining chain still verifies. A redacted row proves only that some record existed there.
  redacted_at INTEGER,
  -- Canonical in-game name at the time (the 42 login mapped to a Minecraft name); client_name is only a claim.
  mc_name     TEXT
);
CREATE INDEX login_audit_by_user ON login_audit(ft_id, at);
CREATE INDEX login_audit_by_ip ON login_audit(ip, at);
CREATE INDEX login_audit_by_token ON login_audit(token_hash);
CREATE INDEX login_audit_by_mojang ON login_audit(mojang_uuid);
CREATE INDEX login_audit_by_name ON login_audit(mc_name COLLATE NOCASE);

-- Rows are never deleted, and the only permitted change is a complete redaction.
CREATE TRIGGER login_audit_redact_only BEFORE UPDATE ON login_audit
WHEN NOT (OLD.redacted_at IS NULL AND NEW.redacted_at IS NOT NULL
  AND NEW.id = OLD.id AND NEW.at = OLD.at AND NEW.event = OLD.event AND NEW.prev_hash = OLD.prev_hash AND NEW.hash = OLD.hash
  AND NEW.ft_id IS NULL AND NEW.login IS NULL AND NEW.mc_uuid IS NULL AND NEW.ip IS NULL AND NEW.ip_source IS NULL
  AND NEW.client_name IS NULL AND NEW.client_uuid IS NULL AND NEW.mojang_uuid IS NULL AND NEW.mojang_name IS NULL
  AND NEW.token_hash IS NULL AND NEW.host IS NULL AND NEW.user_agent IS NULL AND NEW.detail IS NULL AND NEW.mc_name IS NULL)
BEGIN SELECT RAISE(ABORT, 'login_audit is append-only (rows can only be redacted)'); END;
CREATE TRIGGER login_audit_no_delete BEFORE DELETE ON login_audit BEGIN SELECT RAISE(ABORT, 'login_audit is append-only'); END;

-- Deleted accounts: their login_audit rows up to requested_at are redacted once erase_after passes
-- (6 months after deletion). Matched by 42 ID and by the Mojang account linked at deletion time.
CREATE TABLE login_audit_erasure (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ft_id        INTEGER NOT NULL,
  mojang_uuid  TEXT,
  requested_at INTEGER NOT NULL,
  erase_after  INTEGER NOT NULL
);
CREATE INDEX login_audit_erasure_due ON login_audit_erasure(erase_after);
