PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL UNIQUE,
    trusted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    row_id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    file_path TEXT NOT NULL UNIQUE,
    cwd TEXT,
    source_kind TEXT NOT NULL DEFAULT 'codex',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    is_archived INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    parse_status TEXT NOT NULL DEFAULT 'ok',
    parse_error TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    indexed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_archived ON sessions(is_archived, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd);

CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
    title,
    content,
    content='sessions',
    content_rowid='row_id',
    tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS sessions_ai AFTER INSERT ON sessions BEGIN
    INSERT INTO sessions_fts(rowid, title, content)
    VALUES (new.row_id, new.title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS sessions_ad AFTER DELETE ON sessions BEGIN
    INSERT INTO sessions_fts(sessions_fts, rowid, title, content)
    VALUES ('delete', old.row_id, old.title, old.content);
END;

CREATE TRIGGER IF NOT EXISTS sessions_au AFTER UPDATE ON sessions BEGIN
    INSERT INTO sessions_fts(sessions_fts, rowid, title, content)
    VALUES ('delete', old.row_id, old.title, old.content);
    INSERT INTO sessions_fts(rowid, title, content)
    VALUES (new.row_id, new.title, new.content);
END;

CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    logical_name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    source_kind TEXT NOT NULL,
    source_uri TEXT,
    managed INTEGER NOT NULL DEFAULT 0,
    active_revision_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (active_revision_id) REFERENCES skill_revisions(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS skill_revisions (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL,
    tree_hash TEXT NOT NULL,
    declared_version TEXT,
    object_path TEXT NOT NULL,
    source_ref TEXT,
    manifest_json TEXT NOT NULL DEFAULT '{}',
    scan_status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE,
    UNIQUE(skill_id, tree_hash),
    UNIQUE(id, skill_id)
);

CREATE TABLE IF NOT EXISTS skill_locations (
    id TEXT PRIMARY KEY,
    skill_id TEXT,
    agent_type TEXT NOT NULL,
    scope_kind TEXT NOT NULL,
    project_id TEXT,
    skill_path TEXT NOT NULL,
    canonical_path TEXT NOT NULL,
    enabled_state TEXT NOT NULL DEFAULT 'unknown',
    read_only INTEGER NOT NULL DEFAULT 0,
    link_kind TEXT NOT NULL DEFAULT 'directory',
    health_status TEXT NOT NULL DEFAULT 'ok',
    observed_hash TEXT,
    last_seen_at INTEGER NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE SET NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    UNIQUE(agent_type, canonical_path)
);

CREATE INDEX IF NOT EXISTS idx_skill_locations_agent ON skill_locations(agent_type, scope_kind);
CREATE INDEX IF NOT EXISTS idx_skill_locations_skill ON skill_locations(skill_id);

CREATE TABLE IF NOT EXISTS skill_bindings (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    scope_kind TEXT NOT NULL,
    target_root TEXT NOT NULL,
    link_path TEXT NOT NULL UNIQUE,
    link_mode TEXT NOT NULL,
    health_status TEXT NOT NULL DEFAULT 'ok',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE,
    FOREIGN KEY (revision_id, skill_id) REFERENCES skill_revisions(id, skill_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS scan_findings (
    id TEXT PRIMARY KEY,
    revision_id TEXT,
    location_id TEXT,
    rule_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    file_path TEXT,
    line INTEGER,
    message TEXT NOT NULL,
    evidence_redacted TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (revision_id) REFERENCES skill_revisions(id) ON DELETE CASCADE,
    FOREIGN KEY (location_id) REFERENCES skill_locations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY,
    operation_type TEXT NOT NULL,
    target_id TEXT,
    state TEXT NOT NULL,
    current_step TEXT,
    request_json TEXT NOT NULL DEFAULT '{}',
    error_json TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_type TEXT NOT NULL,
    target_id TEXT,
    result TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
);
