ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
CREATE UNIQUE INDEX idx_users_email ON users(email) WHERE email IS NOT NULL;

-- One-time e-mail sign-in / linking codes (only an HMAC of the code is stored).
CREATE TABLE email_codes (
  email       TEXT NOT NULL,
  purpose     TEXT NOT NULL DEFAULT 'login',   -- login | link:<userId>
  code_hash   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (email, purpose)
);
