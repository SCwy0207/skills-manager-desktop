PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS skill_description_localizations (
    skill_id TEXT NOT NULL,
    locale TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('manual', 'translate', 'summarize')),
    description_text TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('manual', 'localModel', 'openai')),
    source_scope TEXT NOT NULL CHECK (source_scope IN ('description', 'manifestExcerpt')),
    provider_id TEXT,
    model_id TEXT,
    prompt_version TEXT NOT NULL,
    source_description_hash TEXT NOT NULL,
    source_manifest_hash TEXT,
    cache_key TEXT NOT NULL,
    token_count INTEGER,
    generated_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (skill_id, locale, mode),
    FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_skill_description_localizations_cache
    ON skill_description_localizations(cache_key);

CREATE TABLE IF NOT EXISTS ai_description_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    provider TEXT NOT NULL DEFAULT 'local' CHECK (provider IN ('local', 'openai')),
    local_endpoint TEXT NOT NULL DEFAULT 'http://127.0.0.1:11434',
    local_model TEXT,
    openai_model TEXT NOT NULL DEFAULT 'gpt-5.6-luna',
    default_mode TEXT NOT NULL DEFAULT 'summarize' CHECK (default_mode IN ('translate', 'summarize')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

INSERT OR IGNORE INTO ai_description_settings(id) VALUES (1);
