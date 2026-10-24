-- One-time tokens that tie a verifier connection to the signed-in player who asked for it (/premium).
-- Stored hashed; consumed on use; short-lived.
CREATE TABLE premium_tokens (
  token_hash TEXT PRIMARY KEY,
  ft_id      INTEGER NOT NULL REFERENCES users(ft_id),
  expires_at INTEGER NOT NULL
);
