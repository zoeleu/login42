-- Replaces name+IP sessions and link codes with client-held cookie tokens and limbo codes.
DROP TABLE sessions;
DROP TABLE link_codes;
DELETE FROM oauth_states;

-- Cookie session tokens. Only the SHA-256 is stored. A token is single-use: logging in with it
-- stamps used_at and issues a new one; presenting a used token again is treated as theft.
CREATE TABLE tokens (
  token_hash TEXT PRIMARY KEY,
  ft_id      INTEGER NOT NULL REFERENCES users(ft_id),
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX tokens_by_user ON tokens(ft_id);

-- One per limbo guest. ft_id: NULL = waiting, 0 = sign-in in progress, >0 = completed.
-- pending_token is handed to the guest's plugin exactly once, then cleared.
CREATE TABLE limbo_codes (
  code          TEXT PRIMARY KEY,
  claimed_name  TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  ft_id         INTEGER,
  pending_token TEXT
);
