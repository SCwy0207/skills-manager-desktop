use std::{
    fs,
    path::Path,
    sync::{Arc, Mutex},
};

use rusqlite::{Connection, OptionalExtension};

use crate::error::{AppError, AppResult};

#[derive(Clone)]
pub struct Database {
    connection: Arc<Mutex<Connection>>,
}

impl Database {
    pub fn open(app_data_dir: &Path) -> AppResult<Self> {
        fs::create_dir_all(app_data_dir)?;
        let path = app_data_dir.join("control-center.sqlite3");
        let mut connection = Connection::open(path)?;
        connection.execute_batch(
            "PRAGMA foreign_keys = ON;\n\
             PRAGMA journal_mode = WAL;\n\
             PRAGMA synchronous = NORMAL;\n\
             PRAGMA busy_timeout = 5000;",
        )?;
        apply_migrations(&mut connection)?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    pub fn with_connection<T>(
        &self,
        operation: impl FnOnce(&Connection) -> AppResult<T>,
    ) -> AppResult<T> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| AppError::Internal("database lock poisoned".to_owned()))?;
        operation(&connection)
    }
}

fn apply_migrations(connection: &mut Connection) -> AppResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version TEXT PRIMARY KEY,
            applied_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
         );",
    )?;
    const MIGRATIONS: &[(&str, &str)] = &[
        ("0001_init", include_str!("../migrations/0001_init.sql")),
        (
            "0002_security_scans",
            include_str!("../migrations/0002_security_scans.sql"),
        ),
        (
            "0003_skill_descriptions",
            include_str!("../migrations/0003_skill_descriptions.sql"),
        ),
        (
            "0004_openai_compatible_provider",
            include_str!("../migrations/0004_openai_compatible_provider.sql"),
        ),
        (
            "0005_custom_skills",
            include_str!("../migrations/0005_custom_skills.sql"),
        ),
        (
            "0006_multi_agent_sessions",
            include_str!("../migrations/0006_multi_agent_sessions.sql"),
        ),
    ];
    for (version, sql) in MIGRATIONS {
        let applied = connection
            .query_row(
                "SELECT 1 FROM schema_migrations WHERE version = ?1",
                [version],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if applied {
            continue;
        }
        let transaction = connection.transaction()?;
        transaction.execute_batch(sql)?;
        transaction.execute(
            "INSERT INTO schema_migrations(version) VALUES (?1)",
            [version],
        )?;
        transaction.commit()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::apply_migrations;
    use rusqlite::{params, Connection};

    #[test]
    fn compatible_provider_migration_preserves_v3_data_and_constraints() {
        let mut connection = Connection::open_in_memory().expect("open in-memory database");
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 CREATE TABLE schema_migrations (
                    version TEXT PRIMARY KEY,
                    applied_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
                 );",
            )
            .expect("create migration ledger");

        for (version, sql) in [
            ("0001_init", include_str!("../migrations/0001_init.sql")),
            (
                "0002_security_scans",
                include_str!("../migrations/0002_security_scans.sql"),
            ),
            (
                "0003_skill_descriptions",
                include_str!("../migrations/0003_skill_descriptions.sql"),
            ),
        ] {
            connection.execute_batch(sql).expect("apply v3 fixture");
            connection
                .execute(
                    "INSERT INTO schema_migrations(version) VALUES (?1)",
                    [version],
                )
                .expect("record fixture migration");
        }

        connection
            .execute(
                "INSERT INTO skills(
                    id, logical_name, display_name, description, source_kind,
                    managed, created_at, updated_at
                 ) VALUES ('skill-1', 'fixture', 'Fixture', 'Original author text',
                           'local', 0, 101, 202)",
                [],
            )
            .expect("insert legacy skill");
        connection
            .execute(
                "INSERT INTO skill_description_localizations(
                    skill_id, locale, mode, description_text, origin, source_scope,
                    provider_id, model_id, prompt_version, source_description_hash,
                    source_manifest_hash, cache_key, token_count, generated_at, updated_at
                 ) VALUES (
                    'skill-1', 'zh-CN', 'summarize', '保留的中文能力总结', 'openai',
                    'manifestExcerpt', 'openai', 'legacy-model', 'prompt-v3',
                    'description-hash', 'manifest-hash', 'cache-hash', 42, 303, 404
                 ), (
                    'skill-1', 'zh-CN', 'manual', '保留的手工简介', 'manual',
                    'description', NULL, NULL, 'manual-v1', 'manual-description-hash',
                    NULL, 'manual-cache-hash', NULL, 505, 606
                 )",
                [],
            )
            .expect("insert legacy localizations");
        connection
            .execute(
                "UPDATE ai_description_settings SET
                    enabled = 1, provider = 'openai',
                    local_endpoint = 'http://127.0.0.1:1234', local_model = 'local-v3',
                    openai_model = 'openai-v3', default_mode = 'translate', updated_at = 707
                 WHERE id = 1",
                [],
            )
            .expect("customize legacy settings");

        apply_migrations(&mut connection).expect("apply compatible provider migration");

        let localization_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM skill_description_localizations WHERE skill_id = 'skill-1'",
                [],
                |row| row.get(0),
            )
            .expect("count migrated localizations");
        assert_eq!(localization_count, 2);

        let localization = connection
            .query_row(
                "SELECT locale, mode, description_text, origin, source_scope, provider_id,
                        model_id, prompt_version, source_description_hash, source_manifest_hash,
                        cache_key, token_count, generated_at, updated_at
                 FROM skill_description_localizations
                 WHERE skill_id = 'skill-1' AND mode = 'summarize'",
                [],
                |row| {
                    Ok(vec![
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                        row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, Option<String>>(9)?.unwrap_or_default(),
                        row.get::<_, String>(10)?,
                        row.get::<_, Option<i64>>(11)?
                            .map(|value| value.to_string())
                            .unwrap_or_default(),
                        row.get::<_, i64>(12)?.to_string(),
                        row.get::<_, i64>(13)?.to_string(),
                    ])
                },
            )
            .expect("read migrated localization");
        assert_eq!(
            localization,
            [
                "zh-CN",
                "summarize",
                "保留的中文能力总结",
                "openai",
                "manifestExcerpt",
                "openai",
                "legacy-model",
                "prompt-v3",
                "description-hash",
                "manifest-hash",
                "cache-hash",
                "42",
                "303",
                "404",
            ]
        );

        let settings = connection
            .query_row(
                "SELECT enabled, provider, local_endpoint, local_model, openai_model,
                        compatible_base_url, compatible_model, default_mode, updated_at
                 FROM ai_description_settings WHERE id = 1",
                [],
                |row| {
                    Ok(vec![
                        row.get::<_, i64>(0)?.to_string(),
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, i64>(8)?.to_string(),
                    ])
                },
            )
            .expect("read migrated settings");
        assert_eq!(
            settings,
            [
                "1",
                "openai",
                "http://127.0.0.1:1234",
                "local-v3",
                "openai-v3",
                "https://api.example.com/v1/chat/completions",
                "gpt-4o-mini",
                "translate",
                "707",
            ]
        );

        let skill_description: String = connection
            .query_row(
                "SELECT description FROM skills WHERE id = 'skill-1'",
                [],
                |row| row.get(0),
            )
            .expect("read preserved skill");
        assert_eq!(skill_description, "Original author text");

        let index_names = {
            let mut statement = connection
                .prepare("PRAGMA index_list('skill_description_localizations')")
                .expect("prepare index list");
            statement
                .query_map([], |row| row.get::<_, String>(1))
                .expect("query indexes")
                .collect::<Result<Vec<_>, _>>()
                .expect("collect indexes")
        };
        assert!(index_names
            .iter()
            .any(|name| name == "idx_skill_description_localizations_cache"));

        {
            let mut statement = connection
                .prepare("PRAGMA foreign_key_check")
                .expect("prepare foreign key check");
            let mut violations = statement.query([]).expect("check foreign keys");
            assert!(violations.next().expect("read foreign key check").is_none());
        }

        connection
            .execute(
                "UPDATE ai_description_settings SET provider = 'compatible' WHERE id = 1",
                [],
            )
            .expect("new provider satisfies rebuilt constraint");
        connection
            .execute(
                "UPDATE skill_description_localizations
                 SET origin = 'openaiCompatible', provider_id = 'compatible'
                 WHERE skill_id = 'skill-1' AND mode = 'summarize'",
                [],
            )
            .expect("new origin satisfies rebuilt constraint");

        let applied: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations
                 WHERE version = '0004_openai_compatible_provider'",
                params![],
                |row| row.get(0),
            )
            .expect("read migration ledger");
        assert_eq!(applied, 1);
    }
}
