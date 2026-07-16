ALTER TABLE sessions ADD COLUMN native_session_id TEXT;
ALTER TABLE sessions ADD COLUMN native_store_path TEXT;
ALTER TABLE sessions ADD COLUMN title_origin TEXT NOT NULL DEFAULT 'derived';
ALTER TABLE sessions ADD COLUMN can_rename INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_sessions_source_updated
ON sessions(source_kind, updated_at DESC);
