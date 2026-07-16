use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    time::Duration,
};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};

use crate::error::{AppError, AppResult};

const CODEX_STATE_DATABASE: &str = "state_5.sqlite";
const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(3);

/// Keep custom names compact enough for every supported session list while
/// still allowing descriptive CJK titles.
pub const MAX_CODEX_THREAD_TITLE_CHARS: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexThreadMetadata {
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived: bool,
    pub rollout_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexThreadRenameResult {
    pub before: CodexThreadMetadata,
    pub after: CodexThreadMetadata,
}

#[derive(Debug)]
struct RawThreadMetadata {
    id: String,
    title: String,
    cwd: String,
    created_at: i64,
    updated_at: i64,
    archived: i64,
    rollout_path: String,
}

#[derive(Debug)]
struct SchemaColumn {
    declared_type: String,
    not_null: bool,
    primary_key_position: i64,
}

#[derive(Clone, Copy)]
struct RequiredColumn {
    name: &'static str,
    declared_type: &'static str,
    not_null: bool,
    primary_key_position: i64,
}

const REQUIRED_THREAD_COLUMNS: &[RequiredColumn] = &[
    RequiredColumn {
        name: "id",
        declared_type: "TEXT",
        // SQLite's canonical Codex schema uses a TEXT PRIMARY KEY without an
        // explicit NOT NULL declaration. The primary-key constraint below is
        // the stable identity check.
        not_null: false,
        primary_key_position: 1,
    },
    RequiredColumn {
        name: "rollout_path",
        declared_type: "TEXT",
        not_null: true,
        primary_key_position: 0,
    },
    RequiredColumn {
        name: "created_at",
        declared_type: "INTEGER",
        not_null: true,
        primary_key_position: 0,
    },
    RequiredColumn {
        name: "updated_at",
        declared_type: "INTEGER",
        not_null: true,
        primary_key_position: 0,
    },
    RequiredColumn {
        name: "cwd",
        declared_type: "TEXT",
        not_null: true,
        primary_key_position: 0,
    },
    RequiredColumn {
        name: "title",
        declared_type: "TEXT",
        not_null: true,
        primary_key_position: 0,
    },
    RequiredColumn {
        name: "archived",
        declared_type: "INTEGER",
        not_null: true,
        primary_key_position: 0,
    },
];

/// Resolves the configured Codex home without creating it.
#[allow(dead_code)]
pub fn codex_home() -> AppResult<PathBuf> {
    let home = env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|path| path.join(".codex")))
        .ok_or_else(|| AppError::Internal("could not determine the Codex home directory".into()))?;

    if !home.is_absolute() {
        return Err(AppError::InvalidInput(
            "CODEX_HOME must be an absolute path".into(),
        ));
    }
    Ok(home)
}

pub fn state_database_path(codex_home: &Path) -> PathBuf {
    codex_home.join(CODEX_STATE_DATABASE)
}

/// Reads the canonical metadata Codex itself uses for a thread title.
///
/// A missing state database or thread is represented by `Ok(None)` so callers
/// can fall back to rollout-derived metadata. An existing database with an
/// unexpected schema is rejected instead of being guessed at.
#[allow(dead_code)]
pub fn read_thread_metadata(
    codex_home: &Path,
    thread_id: &str,
) -> AppResult<Option<CodexThreadMetadata>> {
    read_thread_metadata_from_database(&state_database_path(codex_home), thread_id)
}

/// Reads the canonical Codex thread catalogue in one connection so session
/// indexing can apply native titles without repeatedly reopening SQLite.
pub fn read_thread_catalog(codex_home: &Path) -> AppResult<HashMap<String, CodexThreadMetadata>> {
    let database_path = state_database_path(codex_home);
    if !database_file_exists(&database_path)? {
        return Ok(HashMap::new());
    }
    let connection = open_read_only(&database_path)?;
    validate_threads_schema(&connection)?;
    let mut statement = connection.prepare(
        "SELECT id, title, cwd, created_at, updated_at, archived, rollout_path
         FROM threads",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok(RawThreadMetadata {
                id: row.get(0)?,
                title: row.get(1)?,
                cwd: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                archived: row.get(5)?,
                rollout_path: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(validate_database_row)
        .map(|result| result.map(|metadata| (metadata.id.clone(), metadata)))
        .collect()
}

#[allow(dead_code)]
pub fn read_thread_metadata_from_database(
    database_path: &Path,
    thread_id: &str,
) -> AppResult<Option<CodexThreadMetadata>> {
    validate_thread_id(thread_id)?;
    if !database_file_exists(database_path)? {
        return Ok(None);
    }

    let connection = open_read_only(database_path)?;
    validate_threads_schema(&connection)?;
    query_thread(&connection, thread_id)
}

/// Renames exactly one Codex thread in a short immediate transaction.
///
/// The update is guarded by the title read at the start of the transaction, so
/// a concurrent Codex rename produces a conflict rather than being silently
/// overwritten. No rollout, timestamp, archive flag, or secondary table is
/// modified.
#[allow(dead_code)]
pub fn rename_thread_title(
    codex_home: &Path,
    thread_id: &str,
    new_title: &str,
) -> AppResult<CodexThreadRenameResult> {
    rename_thread_title_in_database(&state_database_path(codex_home), thread_id, new_title)
}

pub fn rename_thread_title_in_database(
    database_path: &Path,
    thread_id: &str,
    new_title: &str,
) -> AppResult<CodexThreadRenameResult> {
    validate_thread_id(thread_id)?;
    let normalized_title = validate_title(new_title)?;
    if !database_file_exists(database_path)? {
        return Err(AppError::NotFound(
            "Codex state database was not found".into(),
        ));
    }

    let mut connection = open_read_write(database_path)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    validate_threads_schema(&transaction)?;

    let before = query_thread(&transaction, thread_id)?
        .ok_or_else(|| AppError::NotFound(format!("Codex thread '{thread_id}' was not found")))?;

    if before.title == normalized_title {
        transaction.commit()?;
        return Ok(CodexThreadRenameResult {
            after: before.clone(),
            before,
        });
    }

    let changed = transaction.execute(
        "UPDATE threads SET title = ?1 WHERE id = ?2 AND title = ?3",
        params![normalized_title, thread_id, &before.title],
    )?;
    if changed != 1 {
        return Err(AppError::Conflict(
            "the Codex thread title changed while it was being renamed".into(),
        ));
    }

    let after = query_thread(&transaction, thread_id)?.ok_or_else(|| {
        AppError::Conflict("the Codex thread disappeared while it was being renamed".into())
    })?;
    verify_only_title_changed(&before, &after, normalized_title)?;
    transaction.commit()?;

    // Verify the committed value on the same connection. This also catches a
    // surprising trigger or immediately competing writer without broadening
    // the mutation performed above.
    let committed = query_thread(&connection, thread_id)?.ok_or_else(|| {
        AppError::Conflict("the renamed Codex thread could not be verified".into())
    })?;
    if committed.title != normalized_title {
        return Err(AppError::Conflict(
            "the committed Codex thread title did not match the requested title".into(),
        ));
    }

    Ok(CodexThreadRenameResult {
        before,
        after: committed,
    })
}

fn database_file_exists(database_path: &Path) -> AppResult<bool> {
    match fs::metadata(database_path) {
        Ok(metadata) if metadata.is_file() => Ok(true),
        Ok(_) => Err(AppError::Unsupported(
            "Codex state database path is not a regular file".into(),
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn open_read_only(database_path: &Path) -> AppResult<Connection> {
    let connection = Connection::open_with_flags(
        database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    configure_connection(&connection, true)?;
    Ok(connection)
}

fn open_read_write(database_path: &Path) -> AppResult<Connection> {
    // Deliberately omit SQLITE_OPEN_CREATE. A typo or missing Codex database
    // must never create a look-alike state file.
    let connection = Connection::open_with_flags(
        database_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    configure_connection(&connection, false)?;
    Ok(connection)
}

fn configure_connection(connection: &Connection, read_only: bool) -> AppResult<()> {
    connection.busy_timeout(SQLITE_BUSY_TIMEOUT)?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "trusted_schema", "OFF")?;
    if read_only {
        connection.pragma_update(None, "query_only", "ON")?;
    }
    Ok(())
}

fn validate_threads_schema(connection: &Connection) -> AppResult<()> {
    let object_type = connection
        .query_row(
            "SELECT type FROM sqlite_master WHERE name = 'threads'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if object_type.as_deref() != Some("table") {
        return Err(unsupported_schema("required 'threads' table is missing"));
    }

    let mut statement = connection.prepare("PRAGMA table_info('threads')")?;
    let columns = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                SchemaColumn {
                    declared_type: row.get::<_, String>(2)?,
                    not_null: row.get::<_, i64>(3)? != 0,
                    primary_key_position: row.get(5)?,
                },
            ))
        })?
        .collect::<Result<HashMap<_, _>, _>>()?;

    for required in REQUIRED_THREAD_COLUMNS {
        let Some(actual) = columns.get(required.name) else {
            return Err(unsupported_schema(&format!(
                "required column 'threads.{}' is missing",
                required.name
            )));
        };
        if !actual
            .declared_type
            .trim()
            .eq_ignore_ascii_case(required.declared_type)
            || actual.not_null != required.not_null
            || actual.primary_key_position != required.primary_key_position
        {
            return Err(unsupported_schema(&format!(
                "column 'threads.{}' has an unexpected definition",
                required.name
            )));
        }
    }

    validate_title_update_triggers(connection)
}

fn validate_title_update_triggers(connection: &Connection) -> AppResult<()> {
    let mut statement = connection.prepare(
        "SELECT name, sql FROM sqlite_master
         WHERE type = 'trigger' AND tbl_name = 'threads'",
    )?;
    let triggers = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    for (name, sql) in triggers {
        let Some(sql) = sql else {
            return Err(unsupported_schema(&format!(
                "trigger '{name}' cannot be inspected safely"
            )));
        };
        if trigger_runs_for_title_update(&sql) {
            return Err(unsupported_schema(&format!(
                "trigger '{name}' may run when a thread title is updated"
            )));
        }
    }
    Ok(())
}

fn trigger_runs_for_title_update(sql: &str) -> bool {
    let normalized = sql
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_uppercase();
    let header = normalized
        .split_once(" BEGIN ")
        .map_or(normalized.as_str(), |(header, _)| header);

    let Some((_, update_clause)) = header.split_once(" UPDATE ") else {
        return false;
    };
    let update_clause = update_clause.trim_start();
    let Some(column_clause) = update_clause.strip_prefix("OF ") else {
        // An UPDATE trigger without an OF list runs for every updated column.
        return true;
    };
    let Some((columns, _)) = column_clause.split_once(" ON ") else {
        return true;
    };

    columns.split(',').any(|column| {
        column
            .trim()
            .trim_matches(|character| matches!(character, '"' | '`' | '[' | ']'))
            == "TITLE"
    })
}

fn query_thread(
    connection: &Connection,
    thread_id: &str,
) -> AppResult<Option<CodexThreadMetadata>> {
    let raw = connection
        .query_row(
            "SELECT id, title, cwd, created_at, updated_at, archived, rollout_path
             FROM threads WHERE id = ?1",
            [thread_id],
            |row| {
                Ok(RawThreadMetadata {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    cwd: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    archived: row.get(5)?,
                    rollout_path: row.get(6)?,
                })
            },
        )
        .optional()?;

    raw.map(validate_database_row).transpose()
}

fn validate_database_row(raw: RawThreadMetadata) -> AppResult<CodexThreadMetadata> {
    let archived = match raw.archived {
        0 => false,
        1 => true,
        _ => {
            return Err(unsupported_schema(
                "column 'threads.archived' contains a non-boolean value",
            ))
        }
    };
    if raw.created_at < 0 || raw.updated_at < 0 {
        return Err(unsupported_schema(
            "thread timestamps contain a negative value",
        ));
    }
    if raw.rollout_path.trim().is_empty() {
        return Err(unsupported_schema("thread rollout_path is empty"));
    }

    Ok(CodexThreadMetadata {
        id: raw.id,
        title: raw.title,
        cwd: raw.cwd,
        created_at: raw.created_at,
        updated_at: raw.updated_at,
        archived,
        rollout_path: PathBuf::from(raw.rollout_path),
    })
}

fn verify_only_title_changed(
    before: &CodexThreadMetadata,
    after: &CodexThreadMetadata,
    expected_title: &str,
) -> AppResult<()> {
    if after.title != expected_title
        || before.id != after.id
        || before.cwd != after.cwd
        || before.created_at != after.created_at
        || before.updated_at != after.updated_at
        || before.archived != after.archived
        || before.rollout_path != after.rollout_path
    {
        return Err(AppError::Conflict(
            "Codex thread metadata changed unexpectedly during rename".into(),
        ));
    }
    Ok(())
}

fn validate_thread_id(thread_id: &str) -> AppResult<()> {
    if thread_id.is_empty()
        || thread_id.len() > 256
        || thread_id.trim() != thread_id
        || thread_id.chars().any(char::is_control)
    {
        return Err(AppError::InvalidInput("Codex thread id is invalid".into()));
    }
    Ok(())
}

fn validate_title(title: &str) -> AppResult<&str> {
    let normalized = title.trim();
    if normalized.is_empty() {
        return Err(AppError::InvalidInput(
            "thread title cannot be empty".into(),
        ));
    }
    if normalized.chars().count() > MAX_CODEX_THREAD_TITLE_CHARS {
        return Err(AppError::InvalidInput(format!(
            "thread title cannot exceed {MAX_CODEX_THREAD_TITLE_CHARS} characters"
        )));
    }
    if normalized.chars().any(char::is_control) {
        return Err(AppError::InvalidInput(
            "thread title must be a single line without control characters".into(),
        ));
    }
    Ok(normalized)
}

fn unsupported_schema(message: &str) -> AppError {
    AppError::Unsupported(format!(
        "unsupported Codex state database schema: {message}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use tempfile::TempDir;

    fn fixture() -> (TempDir, PathBuf) {
        let directory = tempfile::tempdir().expect("create temp directory");
        let database_path = directory.path().join(CODEX_STATE_DATABASE);
        let connection = Connection::open(&database_path).expect("open fixture database");
        connection
            .execute_batch(
                "CREATE TABLE threads (
                    id TEXT PRIMARY KEY,
                    rollout_path TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    cwd TEXT NOT NULL,
                    title TEXT NOT NULL,
                    archived INTEGER NOT NULL DEFAULT 0,
                    preview TEXT NOT NULL DEFAULT ''
                 );
                 INSERT INTO threads(
                    id, rollout_path, created_at, updated_at, cwd, title, archived
                 ) VALUES (
                    'thread-1', 'C:/codex/sessions/rollout-1.jsonl', 101, 202,
                    'D:/workspace/project', 'Original title', 0
                 ), (
                    'thread-2', 'C:/codex/archived/rollout-2.jsonl', 303, 404,
                    'D:/workspace/other', 'Archived title', 1
                 );",
            )
            .expect("create fixture schema");
        drop(connection);
        (directory, database_path)
    }

    #[test]
    fn reads_canonical_thread_metadata_by_id() {
        let (_directory, database_path) = fixture();
        let thread = read_thread_metadata_from_database(&database_path, "thread-2")
            .expect("read metadata")
            .expect("thread exists");

        assert_eq!(thread.id, "thread-2");
        assert_eq!(thread.title, "Archived title");
        assert_eq!(thread.cwd, "D:/workspace/other");
        assert_eq!(thread.created_at, 303);
        assert_eq!(thread.updated_at, 404);
        assert!(thread.archived);
        assert_eq!(
            thread.rollout_path,
            PathBuf::from("C:/codex/archived/rollout-2.jsonl")
        );
    }

    #[test]
    fn reads_the_catalog_in_one_connection() {
        let (directory, _database_path) = fixture();
        let catalog = read_thread_catalog(directory.path()).expect("read catalog");

        assert_eq!(catalog.len(), 2);
        assert_eq!(catalog["thread-1"].title, "Original title");
        assert_eq!(catalog["thread-2"].title, "Archived title");
        assert!(catalog["thread-2"].archived);
    }

    #[test]
    fn missing_database_is_not_created_by_read_or_rename() {
        let directory = tempfile::tempdir().expect("create temp directory");
        let database_path = directory.path().join(CODEX_STATE_DATABASE);

        assert!(
            read_thread_metadata_from_database(&database_path, "thread-1")
                .expect("missing database is an optional source")
                .is_none()
        );
        assert!(!database_path.exists());

        let error = rename_thread_title_in_database(&database_path, "thread-1", "New title")
            .expect_err("rename must not create a database");
        assert!(matches!(error, AppError::NotFound(_)));
        assert!(!database_path.exists());
    }

    #[test]
    fn rejects_an_unexpected_threads_schema() {
        let directory = tempfile::tempdir().expect("create temp directory");
        let database_path = directory.path().join(CODEX_STATE_DATABASE);
        let connection = Connection::open(&database_path).expect("open fixture database");
        connection
            .execute_batch(
                "CREATE TABLE threads (
                    id TEXT PRIMARY KEY,
                    rollout_path TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    cwd TEXT NOT NULL,
                    title BLOB NOT NULL,
                    archived INTEGER NOT NULL DEFAULT 0
                 );",
            )
            .expect("create incompatible fixture");
        drop(connection);

        let error = read_thread_metadata_from_database(&database_path, "thread-1")
            .expect_err("schema mismatch must fail closed");
        assert!(matches!(error, AppError::Unsupported(_)));
    }

    #[test]
    fn rename_changes_only_the_title_and_trims_outer_space() {
        let (_directory, database_path) = fixture();
        let result = rename_thread_title_in_database(&database_path, "thread-1", "  新标题  ")
            .expect("rename thread");

        assert_eq!(result.before.title, "Original title");
        assert_eq!(result.after.title, "新标题");
        assert_eq!(result.before.id, result.after.id);
        assert_eq!(result.before.cwd, result.after.cwd);
        assert_eq!(result.before.created_at, result.after.created_at);
        assert_eq!(result.before.updated_at, result.after.updated_at);
        assert_eq!(result.before.archived, result.after.archived);
        assert_eq!(result.before.rollout_path, result.after.rollout_path);

        let connection = Connection::open(&database_path).expect("reopen database");
        let stored: (String, i64, i64, i64, String) = connection
            .query_row(
                "SELECT title, created_at, updated_at, archived, cwd
                 FROM threads WHERE id = 'thread-1'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .expect("read stored row");
        assert_eq!(
            stored,
            ("新标题".into(), 101, 202, 0, "D:/workspace/project".into())
        );
    }

    #[test]
    fn idempotent_rename_succeeds_without_touching_metadata() {
        let (_directory, database_path) = fixture();
        let result = rename_thread_title_in_database(&database_path, "thread-1", "Original title")
            .expect("idempotent rename");

        assert_eq!(result.before, result.after);
    }

    #[test]
    fn invalid_titles_are_rejected_without_writing() {
        let (_directory, database_path) = fixture();
        for invalid in ["   ", "two\nlines", "tab\ttitle"] {
            let error = rename_thread_title_in_database(&database_path, "thread-1", invalid)
                .expect_err("invalid title must fail");
            assert!(matches!(error, AppError::InvalidInput(_)));
        }

        let too_long = "界".repeat(MAX_CODEX_THREAD_TITLE_CHARS + 1);
        let error = rename_thread_title_in_database(&database_path, "thread-1", &too_long)
            .expect_err("long title must fail");
        assert!(matches!(error, AppError::InvalidInput(_)));

        let stored = read_thread_metadata_from_database(&database_path, "thread-1")
            .expect("read unchanged metadata")
            .expect("thread exists");
        assert_eq!(stored.title, "Original title");
    }

    #[test]
    fn missing_thread_is_reported_without_broad_updates() {
        let (_directory, database_path) = fixture();
        let error = rename_thread_title_in_database(&database_path, "missing", "New title")
            .expect_err("missing thread must fail");
        assert!(matches!(error, AppError::NotFound(_)));

        let connection = Connection::open(&database_path).expect("open database");
        let titles: Vec<String> = connection
            .prepare("SELECT title FROM threads ORDER BY id")
            .expect("prepare title query")
            .query_map([], |row| row.get(0))
            .expect("query titles")
            .collect::<Result<_, _>>()
            .expect("collect titles");
        assert_eq!(titles, ["Original title", "Archived title"]);
    }

    #[test]
    fn column_scoped_timestamp_trigger_does_not_block_title_rename() {
        let (_directory, database_path) = fixture();
        let connection = Connection::open(&database_path).expect("open database");
        connection
            .execute_batch(
                "CREATE TRIGGER update_timestamp_probe
                 AFTER UPDATE OF updated_at ON threads
                 BEGIN
                    SELECT 1;
                 END;",
            )
            .expect("create safe trigger");
        drop(connection);

        let result = rename_thread_title_in_database(&database_path, "thread-1", "New title")
            .expect("safe trigger should not block rename");
        assert_eq!(result.after.title, "New title");
    }

    #[test]
    fn title_update_trigger_fails_closed_before_any_mutation() {
        let (_directory, database_path) = fixture();
        let connection = Connection::open(&database_path).expect("open database");
        connection
            .execute_batch(
                "CREATE TABLE audit_log(value TEXT NOT NULL);
                 CREATE TRIGGER broad_thread_update
                 AFTER UPDATE ON threads
                 BEGIN
                    INSERT INTO audit_log(value) VALUES (NEW.title);
                 END;",
            )
            .expect("create unsafe trigger");
        drop(connection);

        let error = rename_thread_title_in_database(&database_path, "thread-1", "New title")
            .expect_err("broad trigger must fail closed");
        assert!(matches!(error, AppError::Unsupported(_)));

        let connection = Connection::open(&database_path).expect("reopen database");
        let title: String = connection
            .query_row(
                "SELECT title FROM threads WHERE id = 'thread-1'",
                [],
                |row| row.get(0),
            )
            .expect("read title");
        let audit_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM audit_log", [], |row| row.get(0))
            .expect("count audit rows");
        assert_eq!(title, "Original title");
        assert_eq!(audit_count, 0);
    }
}
