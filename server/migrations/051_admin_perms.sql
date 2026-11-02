-- The main administrator hands out rights to the other administrators one by one.
ALTER TABLE users ADD COLUMN admin_owner INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN admin_perms TEXT;
UPDATE users SET admin_owner = 1 WHERE id = (SELECT MIN(id) FROM users WHERE is_admin = 1);
