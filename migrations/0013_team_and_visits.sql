CREATE TABLE scanner_invites (
 id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), token_hash TEXT NOT NULL UNIQUE,
 created_by TEXT NOT NULL REFERENCES operators(id), expires_at TEXT NOT NULL,
 revoked_at TEXT, uses INTEGER NOT NULL DEFAULT 0, max_uses INTEGER NOT NULL DEFAULT 50,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE operators ADD COLUMN scanner_invite_id TEXT REFERENCES scanner_invites(id);
CREATE TABLE event_visitors (
 event_id TEXT NOT NULL REFERENCES events(id), visitor_hash TEXT NOT NULL,
 first_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(event_id, visitor_hash)
);
CREATE TABLE event_documents (
 id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), order_id TEXT REFERENCES orders(id),
 kind TEXT NOT NULL CHECK(kind IN ('FISCAL','LEGAL')), title TEXT NOT NULL, url TEXT NOT NULL,
 created_by TEXT NOT NULL REFERENCES operators(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
