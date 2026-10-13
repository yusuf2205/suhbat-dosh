-- Login + password for every account (administrators keep their separate admin login).
ALTER TABLE users ADD COLUMN pw_hash TEXT;
