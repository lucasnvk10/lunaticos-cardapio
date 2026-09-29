-- Extend team access with a dedicated QR-scanning role while preserving
-- existing operators, device activations, sessions and administrator login.
CREATE TABLE operators_role_backup AS SELECT * FROM operators;
CREATE TABLE activation_tokens_role_backup AS SELECT * FROM activation_tokens;
CREATE TABLE operator_sessions_role_backup AS SELECT * FROM operator_sessions;
CREATE TABLE admin_credentials_role_backup AS SELECT * FROM admin_credentials;

DROP TABLE admin_credentials;
DROP TABLE operator_sessions;
DROP TABLE activation_tokens;
DROP TABLE operators;

CREATE TABLE operators (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN', 'MARKETING', 'BARTENDER', 'EVENTOS')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO operators SELECT * FROM operators_role_backup;

CREATE TABLE activation_tokens (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  operator_id TEXT NOT NULL REFERENCES operators(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO activation_tokens SELECT * FROM activation_tokens_role_backup;

CREATE TABLE operator_sessions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  operator_id TEXT NOT NULL REFERENCES operators(id),
  token_hash TEXT NOT NULL UNIQUE,
  device_label TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO operator_sessions SELECT * FROM operator_sessions_role_backup;

CREATE TABLE admin_credentials (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  operator_id TEXT NOT NULL UNIQUE REFERENCES operators(id),
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO admin_credentials SELECT * FROM admin_credentials_role_backup;

DROP TABLE admin_credentials_role_backup;
DROP TABLE operator_sessions_role_backup;
DROP TABLE activation_tokens_role_backup;
DROP TABLE operators_role_backup;

CREATE INDEX idx_sessions_token ON operator_sessions(token_hash, revoked_at, expires_at);
CREATE UNIQUE INDEX idx_admin_credentials_event ON admin_credentials(event_id);
