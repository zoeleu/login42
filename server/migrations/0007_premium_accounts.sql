-- Account ownership is independent of skin choice: uploading/resetting a skin must not erase login proof.
CREATE TABLE premium_accounts (
  ft_id INTEGER PRIMARY KEY REFERENCES users(ft_id) ON DELETE CASCADE,
  mojang_uuid TEXT NOT NULL UNIQUE,
  verified_at INTEGER NOT NULL
);
INSERT INTO premium_accounts (ft_id, mojang_uuid, verified_at)
SELECT ft_id, mojang_uuid, verified_at FROM skin_source
WHERE kind = 'mojang' AND mojang_uuid IS NOT NULL AND verified_at IS NOT NULL;
