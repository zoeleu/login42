-- Per-key counters in fixed one-minute windows (abuse limits on limbo-code creation).
CREATE TABLE rate_limits (
  key    TEXT NOT NULL,
  window INTEGER NOT NULL,
  count  INTEGER NOT NULL,
  PRIMARY KEY (key, window)
);

-- The in-game name now comes from the 42 login, so a claimed name is no longer stored.
ALTER TABLE limbo_codes DROP COLUMN claimed_name;
