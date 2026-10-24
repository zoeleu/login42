-- Erasure covers login_audit rows up to the last id that existed at deletion time. Timestamps are only
-- millisecond-precise, so a login in the same millisecond as the deletion could otherwise be swept in.
-- Rows scheduled before this migration (up_to_id NULL) keep the timestamp rule.
ALTER TABLE login_audit_erasure ADD COLUMN up_to_id INTEGER;
