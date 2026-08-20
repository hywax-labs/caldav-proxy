export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS calendar_objects (
  source_href_hash TEXT PRIMARY KEY,
  source_uid_hash TEXT NOT NULL,
  public_id TEXT NOT NULL UNIQUE,
  anonymous_uid TEXT NOT NULL,
  source_etag TEXT,
  public_etag TEXT NOT NULL,
  ical TEXT NOT NULL,
  starts_at TEXT,
  ends_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS calendar_objects_anonymous_uid_idx
  ON calendar_objects (anonymous_uid);

CREATE TABLE IF NOT EXISTS sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_successful_sync TEXT,
  last_sync_attempt TEXT,
  last_error TEXT,
  sync_token TEXT,
  last_full_sync TEXT
);

INSERT OR IGNORE INTO sync_state (id) VALUES (1);
`
