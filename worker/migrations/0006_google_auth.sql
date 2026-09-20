-- Google sign-in alongside email/password.
-- google_sub is Google's stable per-account subject id. Email can change; sub cannot.
ALTER TABLE users ADD COLUMN google_sub TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL;

-- pw_hash/pw_salt are NOT NULL from 0002 and SQLite can't relax that without a table rebuild,
-- so Google-only accounts store '' and the login route refuses to match an empty hash.
