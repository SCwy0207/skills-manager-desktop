PRAGMA foreign_keys = ON;

-- SQLite cannot widen CHECK constraints in place. Rebuild the two small v0.6
-- tables so the new provider/origin are accepted without touching user data.
CREATE TABLE skill_description_localizations_v4 (
    skill_id TEXT NOT NULL,
    locale TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('manual', 'translate', 'summarize')),
    description_text TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('manual', 'localModel', 'openai', 'openaiCompatible')),
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

INSERT INTO skill_description_localizations_v4(
    skill_id, locale, mode, description_text, origin, source_scope,
    provider_id, model_id, prompt_version, source_description_hash,
    source_manifest_hash, cache_key, token_count, generated_at, updated_at
)
SELECT
    skill_id, locale, mode, description_text, origin, source_scope,
    provider_id, model_id, prompt_version, source_description_hash,
    source_manifest_hash, cache_key, token_count, generated_at, updated_at
FROM skill_description_localizations;

DROP TABLE skill_description_localizations;
ALTER TABLE skill_description_localizations_v4 RENAME TO skill_description_localizations;

CREATE INDEX idx_skill_description_localizations_cache
    ON skill_description_localizations(cache_key);

CREATE TABLE ai_description_settings_v4 (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    provider TEXT NOT NULL DEFAULT 'local' CHECK (provider IN ('local', 'openai', 'compatible')),
    local_endpoint TEXT NOT NULL DEFAULT 'http://127.0.0.1:11434',
    local_model TEXT,
    openai_model TEXT NOT NULL DEFAULT 'gpt-5.6-luna',
    compatible_base_url TEXT NOT NULL DEFAULT 'https://api.example.com/v1/chat/completions',
    compatible_model TEXT NOT NULL DEFAULT 'gpt-4o-mini',
    default_mode TEXT NOT NULL DEFAULT 'summarize' CHECK (default_mode IN ('translate', 'summarize')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

INSERT INTO ai_description_settings_v4(
    id, enabled, provider, local_endpoint, local_model, openai_model,
    compatible_base_url, compatible_model, default_mode, updated_at
)
SELECT
    id, enabled, provider, local_endpoint, local_model, openai_model,
    'https://api.example.com/v1/chat/completions', 'gpt-4o-mini', default_mode, updated_at
FROM ai_description_settings;

DROP TABLE ai_description_settings;
ALTER TABLE ai_description_settings_v4 RENAME TO ai_description_settings;
