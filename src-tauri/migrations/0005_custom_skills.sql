PRAGMA foreign_keys = ON;

CREATE TABLE custom_skill_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    allow_remote_session_context INTEGER NOT NULL DEFAULT 0 CHECK (allow_remote_session_context IN (0, 1)),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

INSERT INTO custom_skill_settings(id, allow_remote_session_context)
VALUES (1, 0);

CREATE TABLE openapi_search_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    specification_json TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    query_parameter TEXT NOT NULL,
    results_pointer TEXT NOT NULL,
    endpoint_host TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE custom_skill_runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    prompt_text TEXT NOT NULL,
    session_ids_json TEXT NOT NULL DEFAULT '[]',
    session_hashes_json TEXT NOT NULL DEFAULT '{}',
    requirements_json TEXT NOT NULL DEFAULT '[]',
    question_json TEXT,
    web_config_json TEXT NOT NULL DEFAULT '{}',
    candidates_json TEXT NOT NULL DEFAULT '[]',
    files_json TEXT NOT NULL DEFAULT '[]',
    validation_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE custom_skill_integrations (
    agent_type TEXT PRIMARY KEY,
    prompt_status TEXT NOT NULL,
    linked_count INTEGER NOT NULL DEFAULT 0,
    conflict_count INTEGER NOT NULL DEFAULT 0,
    repaired_at INTEGER NOT NULL
);
