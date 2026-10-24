-- Refreshed from the selected Intra title on every OAuth sign-in; NULL means no title.
ALTER TABLE users ADD COLUMN special_title TEXT;
