use std::{
    collections::{HashMap, HashSet},
    env,
    fs::{File, Metadata},
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    sync::OnceLock,
    time::UNIX_EPOCH,
};

use chrono::DateTime;
use regex::{Regex, RegexBuilder};
use rusqlite::{params, params_from_iter, types::Value as SqlValue, OptionalExtension, Row};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

use crate::{
    db::Database,
    error::{AppError, AppResult},
    models::{SessionDetail, SessionSearchRequest, SessionSummary, TextRange},
};

const DEFAULT_RESULT_LIMIT: u32 = 50;
const MAX_RESULT_LIMIT: u32 = 200;
const PREVIEW_CHAR_LIMIT: usize = 240;
const PREVIEW_CONTEXT_BEFORE: usize = 72;
// Bump whenever parsing or candidate-selection rules change. Existing rollout
// files are immutable often enough that file timestamps alone cannot tell us
// a row needs to be rebuilt after improving the indexer.
const SESSION_INDEX_FORMAT_VERSION: u32 = 4;

#[derive(Debug)]
struct FileCandidate {
    path: PathBuf,
    archived: bool,
    fingerprint: FileFingerprint,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileFingerprint {
    size: u64,
    modified_ns: u128,
    modified_secs: i64,
}

#[derive(Debug)]
struct SessionFileIdentity {
    session_id: String,
    thread_source: Option<String>,
}

#[derive(Debug)]
struct IndexedSession {
    session_id: String,
    native_session_id: String,
    native_store_path: String,
    title: String,
    title_origin: &'static str,
    can_rename: bool,
    content: String,
    file_path: String,
    cwd: Option<String>,
    source_kind: &'static str,
    created_at: i64,
    updated_at: i64,
    archived: bool,
    content_hash: String,
    file_size: i64,
    parse_status: &'static str,
    parse_error: Option<String>,
    metadata_json: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum MessageRole {
    User,
    Assistant,
}

#[derive(Debug)]
struct MessageCandidate {
    order: usize,
    role: MessageRole,
    text: String,
    preferred: bool,
}

#[derive(Debug)]
struct StoredSession {
    id: String,
    title: String,
    content: String,
    cwd: Option<String>,
    created_at: i64,
    updated_at: i64,
    archived: bool,
    source_kind: String,
    title_origin: String,
    can_rename: bool,
}

/// Incrementally indexes the Codex session directories under `CODEX_HOME` (or
/// `~/.codex` when the environment variable is not set).
pub fn index_codex_sessions(database: &Database) -> AppResult<usize> {
    let codex_home = env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|path| path.join(".codex")))
        .ok_or_else(|| AppError::Internal("could not determine the Codex home directory".into()))?;

    index_codex_sessions_in(database, &codex_home)
}

/// Refreshes every supported local Agent session source. An absent Claude or
/// Cursor store is a healthy empty source; malformed/private schema variants
/// are isolated by their adapters and never hide valid Codex sessions.
pub fn index_local_sessions(database: &Database) -> AppResult<usize> {
    let mut changed = index_codex_sessions(database)?;
    let external = crate::external_sessions::scan_external_sessions()?;
    changed += persist_external_sessions(database, external)?;
    Ok(changed)
}

fn persist_external_sessions(
    database: &Database,
    scan: crate::external_sessions::AdapterScan,
) -> AppResult<usize> {
    database.with_connection(|connection| {
        let transaction = connection.unchecked_transaction()?;
        let indexed_at = chrono::Utc::now().timestamp();
        let mut changed = 0usize;
        let mut seen = HashMap::<String, HashSet<String>>::new();

        for session in &scan.sessions {
            seen.entry(session.source_kind.clone())
                .or_default()
                .insert(session.session_id.clone());
            let unchanged = transaction
                .query_row(
                    "SELECT content_hash, title, file_path, source_kind, native_session_id,
                            native_store_path, cwd, title_origin, can_rename, created_at, updated_at,
                            is_archived, file_size, parse_status, parse_error, metadata_json
                     FROM sessions WHERE session_id = ?1",
                    [&session.session_id],
                    |row| {
                        Ok(
                            row.get::<_, String>(0)? == session.content_hash
                                && row.get::<_, String>(1)? == session.title
                                && row.get::<_, String>(2)? == session.file_path
                                && row.get::<_, String>(3)? == session.source_kind
                                && row.get::<_, Option<String>>(4)?.as_deref()
                                    == Some(session.native_session_id.as_str())
                                && row.get::<_, Option<String>>(5)?.as_deref()
                                    == Some(session.native_store_path.as_str())
                                && row.get::<_, Option<String>>(6)? == session.cwd
                                && row.get::<_, String>(7)? == session.title_origin
                                && (row.get::<_, i64>(8)? != 0) == session.can_rename
                                && row.get::<_, i64>(9)? == session.created_at
                                && row.get::<_, i64>(10)? == session.updated_at
                                && (row.get::<_, i64>(11)? != 0) == session.archived
                                && row.get::<_, i64>(12)? == session.file_size
                                && row.get::<_, String>(13)? == session.parse_status
                                && row.get::<_, Option<String>>(14)? == session.parse_error
                                && row.get::<_, String>(15)? == session.metadata_json,
                        )
                    },
                )
                .optional()?
                .unwrap_or(false);
            if unchanged {
                continue;
            }

            transaction.execute(
                "INSERT INTO sessions (
                    session_id, title, content, file_path, cwd, source_kind, native_session_id,
                    native_store_path, title_origin, can_rename, created_at, updated_at, is_archived, content_hash,
                    file_size, parse_status, parse_error, metadata_json, indexed_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
                 ON CONFLICT(session_id) DO UPDATE SET
                    title = excluded.title,
                    content = excluded.content,
                    file_path = excluded.file_path,
                    cwd = excluded.cwd,
                    source_kind = excluded.source_kind,
                    native_session_id = excluded.native_session_id,
                    native_store_path = excluded.native_store_path,
                    title_origin = excluded.title_origin,
                    can_rename = excluded.can_rename,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at,
                    is_archived = excluded.is_archived,
                    content_hash = excluded.content_hash,
                    file_size = excluded.file_size,
                    parse_status = excluded.parse_status,
                    parse_error = excluded.parse_error,
                    metadata_json = excluded.metadata_json,
                    indexed_at = excluded.indexed_at",
                params![
                    &session.session_id,
                    &session.title,
                    &session.content,
                    &session.file_path,
                    &session.cwd,
                    &session.source_kind,
                    &session.native_session_id,
                    &session.native_store_path,
                    &session.title_origin,
                    session.can_rename as i64,
                    session.created_at,
                    session.updated_at,
                    session.archived as i64,
                    &session.content_hash,
                    session.file_size,
                    &session.parse_status,
                    &session.parse_error,
                    &session.metadata_json,
                    indexed_at,
                ],
            )?;
            changed += 1;
        }

        for source in scan.completed_sources {
            let current = seen.remove(&source).unwrap_or_default();
            let mut statement = transaction
                .prepare("SELECT session_id FROM sessions WHERE source_kind = ?1")?;
            let stale = statement
                .query_map([&source], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .filter(|id| !current.contains(id))
                .collect::<Vec<_>>();
            drop(statement);
            for id in stale {
                changed += transaction.execute(
                    "DELETE FROM sessions WHERE session_id = ?1 AND source_kind = ?2",
                    params![id, source],
                )?;
            }
        }

        transaction.commit()?;
        Ok(changed)
    })
}

fn index_codex_sessions_in(database: &Database, codex_home: &Path) -> AppResult<usize> {
    let active_root = codex_home.join("sessions");
    let archived_root = codex_home.join("archived_sessions");
    let (mut candidates, active_complete) = collect_jsonl_files(&active_root, false);
    let (mut archived, archived_complete) = collect_jsonl_files(&archived_root, true);
    candidates.append(&mut archived);
    candidates.sort_by(|left, right| left.path.cmp(&right.path));

    // Codex writes auxiliary rollout files for subagents. They share the main
    // thread's session_id but contain tool/context traffic rather than the
    // conversation shown in Codex's sidebar, so only the user thread is kept.
    // The selected paths also drive stale-row reconciliation, which removes
    // incorrectly indexed subagent rows from earlier app versions.
    let candidates = select_preferred_session_files(candidates);
    let catalog = crate::codex_catalog::read_thread_catalog(codex_home).unwrap_or_default();
    let catalog_path = crate::codex_catalog::state_database_path(codex_home);
    let seen_paths = candidates
        .iter()
        .map(|candidate| path_to_string(&candidate.path))
        .collect::<HashSet<_>>();

    let mut changed = Vec::new();
    for candidate in &candidates {
        let file_path = path_to_string(&candidate.path);
        let catalog_thread = probe_session_identity(&candidate.path)
            .and_then(|identity| catalog.get(&identity.session_id).cloned());
        let unchanged = database.with_connection(|connection| {
            let stored = connection
                .query_row(
                    "SELECT file_size, is_archived, metadata_json, title, cwd, updated_at
                     FROM sessions WHERE file_path = ?1",
                    [&file_path],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)? != 0,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, Option<String>>(4)?,
                            row.get::<_, i64>(5)?,
                        ))
                    },
                )
                .optional()?;

            Ok(
                stored.is_some_and(|(size, archived, metadata, title, cwd, updated_at)| {
                    let catalog_matches = catalog_thread.as_ref().is_none_or(|thread| {
                        title == thread.title
                            && cwd.as_deref() == Some(thread.cwd.as_str())
                            && updated_at == thread.updated_at
                            && archived == thread.archived
                    });
                    let expected_archived = catalog_thread
                        .as_ref()
                        .map_or(candidate.archived, |thread| thread.archived);
                    catalog_matches
                        && size == saturating_i64(candidate.fingerprint.size)
                        && archived == expected_archived
                        && metadata_modified_ns(&metadata)
                            == Some(candidate.fingerprint.modified_ns)
                        && metadata_index_version(&metadata) == Some(SESSION_INDEX_FORMAT_VERSION)
                }),
            )
        })?;

        if unchanged {
            continue;
        }

        // A malformed line does not poison the rest of a rollout. A transient
        // file-open error is skipped so an already-good row is never replaced
        // by an empty placeholder.
        if let Ok(mut session) = parse_session_file(candidate) {
            if let Some(thread) = catalog_thread {
                session.title = thread.title;
                session.title_origin = "native";
                session.can_rename = true;
                session.cwd = Some(thread.cwd);
                session.created_at = thread.created_at;
                session.updated_at = thread.updated_at;
                session.archived = thread.archived;
                session.native_store_path = path_to_string(&catalog_path);
                if let Ok(mut metadata) = serde_json::from_str::<Value>(&session.metadata_json) {
                    if let Some(object) = metadata.as_object_mut() {
                        object.insert(
                            "codexCatalog".into(),
                            json!({"stateDatabase": path_to_string(&catalog_path)}),
                        );
                    }
                    session.metadata_json = metadata.to_string();
                }
            }
            changed.push(session);
        }
    }

    database.with_connection(|connection| {
        let transaction = connection.unchecked_transaction()?;
        let indexed_at = chrono::Utc::now().timestamp();

        for session in &changed {
            // A file may have been rewritten with a different session id. Clear
            // that stale identity before applying the two UNIQUE constraints.
            transaction.execute(
                "DELETE FROM sessions WHERE file_path = ?1 AND session_id <> ?2",
                params![&session.file_path, &session.session_id],
            )?;
            transaction.execute(
                "INSERT INTO sessions (
                    session_id, title, content, file_path, cwd, source_kind, native_session_id,
                    native_store_path, title_origin, can_rename, created_at, updated_at, is_archived, content_hash,
                    file_size, parse_status, parse_error, metadata_json, indexed_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
                 ON CONFLICT(session_id) DO UPDATE SET
                    title = excluded.title,
                    content = excluded.content,
                    file_path = excluded.file_path,
                    cwd = excluded.cwd,
                    source_kind = excluded.source_kind,
                    native_session_id = excluded.native_session_id,
                    native_store_path = excluded.native_store_path,
                    title_origin = excluded.title_origin,
                    can_rename = excluded.can_rename,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at,
                    is_archived = excluded.is_archived,
                    content_hash = excluded.content_hash,
                    file_size = excluded.file_size,
                    parse_status = excluded.parse_status,
                    parse_error = excluded.parse_error,
                    metadata_json = excluded.metadata_json,
                    indexed_at = excluded.indexed_at",
                params![
                    &session.session_id,
                    &session.title,
                    &session.content,
                    &session.file_path,
                    &session.cwd,
                    session.source_kind,
                    &session.native_session_id,
                    &session.native_store_path,
                    session.title_origin,
                    session.can_rename as i64,
                    session.created_at,
                    session.updated_at,
                    session.archived as i64,
                    &session.content_hash,
                    session.file_size,
                    session.parse_status,
                    &session.parse_error,
                    &session.metadata_json,
                    indexed_at,
                ],
            )?;
        }

        // Reconcile only roots that were traversed without errors. This removes
        // deleted rollouts without turning a temporary permission failure into
        // data loss.
        let completed_roots = [
            active_complete.then_some(active_root.as_path()),
            archived_complete.then_some(archived_root.as_path()),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();

        let stale_paths = if completed_roots.is_empty() {
            Vec::new()
        } else {
            let mut statement = transaction
                .prepare("SELECT file_path FROM sessions WHERE source_kind = 'codex'")?;
            let paths = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            paths
                .into_iter()
                .filter(|stored_path| {
                    let path = Path::new(stored_path);
                    completed_roots.iter().any(|root| path.starts_with(root))
                        && !seen_paths.contains(stored_path)
                })
                .collect::<Vec<_>>()
        };

        for path in &stale_paths {
            transaction.execute("DELETE FROM sessions WHERE file_path = ?1", [path])?;
        }

        transaction.commit()?;
        Ok(changed.len() + stale_paths.len())
    })
}

/// Searches indexed sessions. Empty queries are valid and return the normal
/// updated-at list. Queries of three or more Unicode scalar values use FTS5's
/// trigram index; one- and two-character queries use a literal substring path.
pub fn search_sessions(
    database: &Database,
    request: &SessionSearchRequest,
) -> AppResult<Vec<SessionSummary>> {
    let query = request.query.trim();
    if query.contains('\0') {
        return Err(AppError::InvalidInput(
            "session search query cannot contain a NUL character".into(),
        ));
    }

    let limit = request
        .limit
        .unwrap_or(DEFAULT_RESULT_LIMIT)
        .clamp(1, MAX_RESULT_LIMIT);
    let offset = request.offset.unwrap_or(0);

    database.with_connection(|connection| {
        let mut values = Vec::<SqlValue>::new();
        let mut conditions = Vec::<String>::new();
        let use_fts = !query.is_empty() && query.chars().count() >= 3;

        let from_clause = if use_fts {
            values.push(SqlValue::Text(fts_literal_query(query)));
            conditions.push(format!("sessions_fts MATCH ?{}", values.len()));
            "sessions s JOIN sessions_fts ON sessions_fts.rowid = s.row_id"
        } else {
            if !query.is_empty() {
                values.push(SqlValue::Text(query.to_owned()));
                let literal = values.len();
                values.push(SqlValue::Text(like_contains_pattern(query)));
                let pattern = values.len();
                conditions.push(format!(
                    "(instr(s.title, ?{literal}) > 0 OR instr(s.content, ?{literal}) > 0 \
                     OR s.title LIKE ?{pattern} ESCAPE '\\' \
                     OR s.content LIKE ?{pattern} ESCAPE '\\')"
                ));
            }
            "sessions s"
        };

        if let Some(archived) = request.archived {
            values.push(SqlValue::Integer(archived as i64));
            conditions.push(format!("s.is_archived = ?{}", values.len()));
        }
        if let Some(cwd) = request.cwd.as_deref().filter(|value| !value.is_empty()) {
            let root = normalize_scope_path(cwd);
            let descendant_prefix = if root.ends_with('/') {
                root.clone()
            } else {
                format!("{root}/")
            };
            values.push(SqlValue::Text(root));
            let root_parameter = values.len();
            values.push(SqlValue::Text(descendant_prefix));
            let descendant_parameter = values.len();

            #[cfg(target_os = "windows")]
            let stored_path = {
                let slashes = "replace(s.cwd, '\\', '/')";
                format!(
                    "lower(CASE \
                        WHEN lower(substr({slashes}, 1, 8)) = '//?/unc/' \
                            THEN '//' || substr({slashes}, 9) \
                        WHEN substr({slashes}, 1, 4) = '//?/' \
                            THEN substr({slashes}, 5) \
                        ELSE {slashes} END)"
                )
            };
            #[cfg(not(target_os = "windows"))]
            let stored_path = "s.cwd".to_owned();

            conditions.push(format!(
                "({stored_path} = ?{root_parameter} OR \
                  instr({stored_path}, ?{descendant_parameter}) = 1)"
            ));
        }

        let where_clause = if conditions.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", conditions.join(" AND "))
        };
        let order_clause = if use_fts {
            " ORDER BY bm25(sessions_fts, 5.0, 1.0), s.updated_at DESC, s.row_id DESC"
        } else {
            " ORDER BY s.updated_at DESC, s.row_id DESC"
        };

        values.push(SqlValue::Integer(i64::from(limit)));
        let limit_parameter = values.len();
        values.push(SqlValue::Integer(i64::from(offset)));
        let offset_parameter = values.len();
        let sql = format!(
            "SELECT s.session_id, s.title, s.content, s.cwd, s.created_at, s.updated_at,
                    s.is_archived, s.source_kind, s.title_origin, s.can_rename
             FROM {from_clause}{where_clause}{order_clause}
             LIMIT ?{limit_parameter} OFFSET ?{offset_parameter}"
        );

        let mut statement = connection.prepare(&sql)?;
        let sessions = statement
            .query_map(params_from_iter(values), map_stored_session)?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(sessions
            .into_iter()
            .map(|stored| stored.into_summary(query))
            .collect())
    })
}

fn normalize_scope_path(path: &str) -> String {
    #[cfg(target_os = "windows")]
    let mut normalized = {
        let mut value = path.replace('\\', "/");
        let lowercase = value.to_ascii_lowercase();
        if lowercase.starts_with("//?/unc/") {
            value = format!("//{}", &value[8..]);
        } else if value.starts_with("//?/") {
            value.drain(..4);
        }
        value.make_ascii_lowercase();
        value
    };

    #[cfg(not(target_os = "windows"))]
    let mut normalized = path.to_owned();

    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    normalized
}

pub fn get_session(database: &Database, id: &str) -> AppResult<SessionDetail> {
    database.with_connection(|connection| {
        let stored = connection
            .query_row(
                "SELECT session_id, title, content, cwd, created_at, updated_at, is_archived,
                        source_kind, title_origin, can_rename, file_path, metadata_json,
                        parse_status, parse_error
                 FROM sessions WHERE session_id = ?1",
                [id],
                |row| {
                    Ok((
                        map_stored_session(row)?,
                        row.get::<_, String>(10)?,
                        row.get::<_, String>(11)?,
                        row.get::<_, String>(12)?,
                        row.get::<_, Option<String>>(13)?,
                    ))
                },
            )
            .optional()?;

        let (stored, file_path, metadata_json, parse_status, parse_error) =
            stored.ok_or_else(|| AppError::NotFound(format!("session '{id}' was not found")))?;
        let mut metadata = serde_json::from_str::<Value>(&metadata_json)
            .unwrap_or_else(|_| Value::Object(Map::new()));
        if let Some(object) = metadata.as_object_mut() {
            object.insert("parseStatus".into(), Value::String(parse_status));
            if let Some(error) = parse_error {
                object.insert("parseError".into(), Value::String(error));
            }
        }

        let content = stored.content.clone();
        Ok(SessionDetail {
            summary: stored.into_summary(""),
            content,
            file_path,
            metadata,
        })
    })
}

pub fn rename_session(
    database: &Database,
    id: &str,
    requested_title: &str,
) -> AppResult<SessionSummary> {
    let title = requested_title.trim();
    if title.is_empty()
        || title.chars().count() > 120
        || title.chars().any(char::is_control)
        || title.contains(['\r', '\n'])
    {
        return Err(AppError::InvalidInput(
            "session title must be one line with 1 to 120 characters".into(),
        ));
    }

    let (source_kind, native_session_id, native_store_path, can_rename) = database
        .with_connection(|connection| {
            connection
                .query_row(
                    "SELECT source_kind, native_session_id, native_store_path, can_rename
                     FROM sessions WHERE session_id = ?1",
                    [id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, i64>(3)? != 0,
                        ))
                    },
                )
                .optional()?
                .ok_or_else(|| AppError::NotFound(format!("session '{id}' was not found")))
        })?;
    if !can_rename {
        return Err(AppError::Unsupported(format!(
            "{source_kind} session does not expose a verified native rename store"
        )));
    }
    let native_session_id = native_session_id.ok_or_else(|| {
        AppError::Unsupported("session is missing its native source identity".into())
    })?;
    let native_store_path = native_store_path.ok_or_else(|| {
        AppError::Unsupported("session is missing its native source store".into())
    })?;

    match source_kind.as_str() {
        "codex" => {
            crate::codex_catalog::rename_thread_title_in_database(
                Path::new(&native_store_path),
                &native_session_id,
                title,
            )?;
        }
        "claude" | "cursor" => {
            crate::external_sessions::rename_external_session(
                &source_kind,
                &native_session_id,
                Path::new(&native_store_path),
                title,
            )?;
        }
        _ => {
            return Err(AppError::Unsupported(format!(
                "session source '{source_kind}' does not support rename"
            )));
        }
    }

    database.with_connection(|connection| {
        let changed = connection.execute(
            "UPDATE sessions
             SET title = ?1, title_origin = 'native', indexed_at = ?2
             WHERE session_id = ?3",
            params![title, chrono::Utc::now().timestamp(), id],
        )?;
        if changed != 1 {
            return Err(AppError::Conflict(
                "native session was renamed but the local index changed concurrently".into(),
            ));
        }
        Ok(())
    })?;

    Ok(get_session(database, id)?.summary)
}

impl StoredSession {
    fn into_summary(self, query: &str) -> SessionSummary {
        let (preview, match_ranges) = make_preview(&self.title, &self.content, query);
        SessionSummary {
            id: self.id,
            title: self.title,
            preview,
            cwd: self.cwd,
            created_at: self.created_at,
            updated_at: self.updated_at,
            archived: self.archived,
            agent_type: self.source_kind.clone(),
            source_kind: self.source_kind,
            title_origin: self.title_origin,
            can_rename: self.can_rename,
            match_ranges,
        }
    }
}

fn map_stored_session(row: &Row<'_>) -> rusqlite::Result<StoredSession> {
    Ok(StoredSession {
        id: row.get(0)?,
        title: row.get(1)?,
        content: row.get(2)?,
        cwd: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        archived: row.get::<_, i64>(6)? != 0,
        source_kind: row.get(7)?,
        title_origin: row.get(8)?,
        can_rename: row.get::<_, i64>(9)? != 0,
    })
}

fn collect_jsonl_files(root: &Path, archived: bool) -> (Vec<FileCandidate>, bool) {
    if !root.exists() {
        return (Vec::new(), true);
    }

    let mut files = Vec::new();
    let mut complete = true;
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                complete = false;
                continue;
            }
        };
        if !entry.file_type().is_file()
            || !entry
                .path()
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("jsonl"))
        {
            continue;
        }
        match entry
            .metadata()
            .ok()
            .and_then(|metadata| fingerprint(&metadata).ok())
        {
            Some(fingerprint) => files.push(FileCandidate {
                path: entry.into_path(),
                archived,
                fingerprint,
            }),
            None => complete = false,
        }
    }
    (files, complete)
}

fn select_preferred_session_files(candidates: Vec<FileCandidate>) -> Vec<FileCandidate> {
    let mut selected = HashMap::<String, (FileCandidate, bool)>::new();
    for candidate in candidates {
        let identity =
            probe_session_identity(&candidate.path).unwrap_or_else(|| SessionFileIdentity {
                session_id: fallback_session_id(&candidate.path),
                thread_source: None,
            });
        // Desktop Codex stores guardian/subagent tool traces alongside the
        // user-visible rollout. Those traces do not have a matching sidebar
        // entry and were the source of duplicate “Untitled session” rows.
        if identity.thread_source.as_deref() == Some("subagent") {
            continue;
        }
        let is_user_thread = identity.thread_source.as_deref() == Some("user");
        let replace = selected
            .get(&identity.session_id)
            .map(|(current, current_is_user_thread)| {
                candidate_precedes(&candidate, is_user_thread, current, *current_is_user_thread)
            })
            .unwrap_or(true);
        if replace {
            selected.insert(identity.session_id, (candidate, is_user_thread));
        }
    }

    let mut selected = selected
        .into_values()
        .map(|(candidate, _)| candidate)
        .collect::<Vec<_>>();
    selected.sort_by(|left, right| left.path.cmp(&right.path));
    selected
}

fn candidate_precedes(
    candidate: &FileCandidate,
    candidate_is_user_thread: bool,
    current: &FileCandidate,
    current_is_user_thread: bool,
) -> bool {
    match (candidate_is_user_thread, current_is_user_thread) {
        (true, false) => return true,
        (false, true) => return false,
        _ => {}
    }
    match (candidate.archived, current.archived) {
        (false, true) => return true,
        (true, false) => return false,
        _ => {}
    }
    if candidate.fingerprint.modified_ns != current.fingerprint.modified_ns {
        return candidate.fingerprint.modified_ns > current.fingerprint.modified_ns;
    }
    candidate.path < current.path
}

fn probe_session_identity(path: &Path) -> Option<SessionFileIdentity> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut raw_line = Vec::new();

    loop {
        raw_line.clear();
        let read = reader.read_until(b'\n', &mut raw_line).ok()?;
        if read == 0 {
            return None;
        }
        let json_bytes = trim_jsonl_line(&raw_line);
        if json_bytes.is_empty() {
            continue;
        }
        let value = match serde_json::from_slice::<Value>(json_bytes) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let payload = value.get("payload").unwrap_or(&Value::Null);
        let record_type = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if record_type == "session_meta" {
            let metadata_source = if payload.is_object() { payload } else { &value };
            if let Some(session_id) =
                string_field(metadata_source, &["session_id", "conversation_id", "id"])
            {
                return Some(SessionFileIdentity {
                    session_id,
                    thread_source: string_field(metadata_source, &["thread_source"]),
                });
            }
        }
        if let Some(session_id) = string_field(payload, &["session_id", "conversation_id"]) {
            return Some(SessionFileIdentity {
                session_id,
                thread_source: None,
            });
        }
    }
}

fn fingerprint(metadata: &Metadata) -> std::io::Result<FileFingerprint> {
    let modified = metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    Ok(FileFingerprint {
        size: metadata.len(),
        modified_ns: modified.as_nanos(),
        modified_secs: saturating_i64(modified.as_secs()),
    })
}

fn parse_session_file(candidate: &FileCandidate) -> AppResult<IndexedSession> {
    let file = File::open(&candidate.path)?;
    let mut reader = BufReader::new(file);
    let mut raw_line = Vec::new();
    let mut hasher = Sha256::new();
    let mut line_number = 0usize;
    let mut valid_lines = 0usize;
    let mut malformed_lines = 0usize;
    let mut first_malformed_line = None;
    let mut session_id = None;
    let mut cwd = None;
    let mut explicit_title = None;
    let mut session_created_at = None;
    let mut earliest_timestamp = None;
    let mut latest_timestamp = None;
    let mut session_meta = Map::new();
    let mut messages = Vec::<MessageCandidate>::new();

    loop {
        raw_line.clear();
        let read = reader.read_until(b'\n', &mut raw_line)?;
        if read == 0 {
            break;
        }
        line_number += 1;
        hasher.update(&raw_line);
        let json_bytes = trim_jsonl_line(&raw_line);
        if json_bytes.is_empty() {
            continue;
        }

        let value = match serde_json::from_slice::<Value>(json_bytes) {
            Ok(value) => value,
            Err(_) => {
                malformed_lines += 1;
                first_malformed_line.get_or_insert(line_number);
                continue;
            }
        };
        valid_lines += 1;

        for key in ["timestamp", "created_at", "updated_at"] {
            if let Some(timestamp) = value.get(key).and_then(timestamp_value) {
                update_time_bounds(timestamp, &mut earliest_timestamp, &mut latest_timestamp);
            }
        }
        let payload = value.get("payload").unwrap_or(&Value::Null);
        for key in [
            "timestamp",
            "created_at",
            "updated_at",
            "started_at",
            "completed_at",
        ] {
            if let Some(timestamp) = payload.get(key).and_then(timestamp_value) {
                update_time_bounds(timestamp, &mut earliest_timestamp, &mut latest_timestamp);
            }
        }

        let record_type = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let payload_type = payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();

        if record_type == "session_meta" {
            // Early rollout versions stored metadata directly on the JSONL
            // object; current versions put it under `payload`.
            let metadata_source = if payload.is_object() { payload } else { &value };
            if session_id.is_none() {
                session_id =
                    string_field(metadata_source, &["session_id", "conversation_id", "id"]);
            }
            if cwd.is_none() {
                cwd = string_field(metadata_source, &["cwd", "working_directory"]);
            }
            if explicit_title.is_none() {
                explicit_title = string_field(metadata_source, &["title"]);
            }
            session_created_at = metadata_source
                .get("timestamp")
                .and_then(timestamp_value)
                .or(session_created_at);
            for key in [
                "id",
                "timestamp",
                "cwd",
                "cli_version",
                "model_provider",
                "originator",
                "source",
            ] {
                if let Some(field) = metadata_source.get(key) {
                    session_meta.insert(key.to_owned(), field.clone());
                }
            }
        }

        if session_id.is_none() {
            session_id = string_field(payload, &["session_id", "conversation_id"]);
        }
        if cwd.is_none() {
            cwd = string_field(payload, &["cwd", "working_directory"]);
        }

        if record_type == "event_msg" && payload_type == "user_message" {
            if let Some(text) = string_field(payload, &["message", "text"]) {
                push_message(&mut messages, line_number, MessageRole::User, text, true);
            }
        } else if record_type == "event_msg" && payload_type == "agent_message" {
            if let Some(text) = string_field(payload, &["message", "text"]) {
                push_message(
                    &mut messages,
                    line_number,
                    MessageRole::Assistant,
                    text,
                    true,
                );
            }
        } else if (record_type == "response_item" && payload_type == "message")
            || record_type == "message"
        {
            let message = if record_type == "message" {
                &value
            } else {
                payload
            };
            let role = match message.get("role").and_then(Value::as_str) {
                Some("user") => Some(MessageRole::User),
                Some("assistant") => Some(MessageRole::Assistant),
                _ => None,
            };
            if let (Some(role), Some(text)) = (role, extract_message_content(message)) {
                push_message(&mut messages, line_number, role, text, false);
            }
        }
    }

    deduplicate_mirrored_messages(&mut messages);

    let first_user_message = messages
        .iter()
        .find(|message| message.role == MessageRole::User)
        .map(|message| message.text.as_str());
    let native_title = explicit_title
        .as_deref()
        .filter(|title| !is_placeholder_title(title));
    let title_origin = if native_title.is_some() {
        "native"
    } else {
        "derived"
    };
    let title = native_title
        .or(first_user_message)
        .map(clean_title)
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| "Untitled session".to_owned());
    let content = messages
        .iter()
        .map(|message| message.text.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let fallback_time = candidate.fingerprint.modified_secs;
    let created_at = session_created_at
        .or(earliest_timestamp)
        .unwrap_or(fallback_time);
    let updated_at = latest_timestamp.unwrap_or(fallback_time).max(created_at);
    let session_id = session_id
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| fallback_session_id(&candidate.path));
    let native_session_id = session_id.clone();
    let parse_status = match (valid_lines, malformed_lines) {
        (0, _) => "error",
        (_, 0) => "ok",
        _ => "partial",
    };
    let parse_error = (malformed_lines > 0).then(|| {
        format!(
            "{malformed_lines} malformed JSONL line(s); first error at line {}",
            first_malformed_line.unwrap_or(1)
        )
    });
    let metadata = json!({
        "sessionMeta": Value::Object(session_meta),
        "_index": {
            "formatVersion": SESSION_INDEX_FORMAT_VERSION,
            "lineCount": line_number,
            "validLineCount": valid_lines,
            "malformedLineCount": malformed_lines,
            // A string preserves the full u128 nanosecond value in JSON.
            "fileModifiedNs": candidate.fingerprint.modified_ns.to_string(),
        }
    });

    Ok(IndexedSession {
        session_id,
        native_session_id,
        native_store_path: path_to_string(&candidate.path),
        title,
        title_origin,
        can_rename: false,
        content,
        file_path: path_to_string(&candidate.path),
        cwd,
        source_kind: "codex",
        created_at,
        updated_at,
        archived: candidate.archived,
        content_hash: hex::encode(hasher.finalize()),
        file_size: saturating_i64(candidate.fingerprint.size),
        parse_status,
        parse_error,
        metadata_json: metadata.to_string(),
    })
}

fn push_message(
    messages: &mut Vec<MessageCandidate>,
    order: usize,
    role: MessageRole,
    text: String,
    preferred: bool,
) {
    let text = strip_leading_system_context(&text.replace('\0', "�"));
    if text.is_empty() || is_control_message(&text) {
        return;
    }
    messages.push(MessageCandidate {
        order,
        role,
        text,
        preferred,
    });
}

fn strip_leading_system_context(text: &str) -> String {
    let mut remaining = text.trim();
    loop {
        if remaining.starts_with("# Files mentioned by the user:") {
            if let Some(request_start) = remaining.find("## My request for Codex:") {
                remaining = &remaining[request_start + "## My request for Codex:".len()..];
                continue;
            }
            return String::new();
        }
        if remaining.starts_with("# AGENTS.md instructions") {
            let Some(end) = remaining.find("</INSTRUCTIONS>") else {
                return String::new();
            };
            remaining = &remaining[end + "</INSTRUCTIONS>".len()..];
            continue;
        }

        let mut removed_block = false;
        for (opening, closing) in [
            ("<environment_context>", "</environment_context>"),
            ("<permissions instructions>", "</permissions instructions>"),
            ("<skills_instructions>", "</skills_instructions>"),
            ("<apps_instructions>", "</apps_instructions>"),
            ("<plugins_instructions>", "</plugins_instructions>"),
            ("<recommended_plugins>", "</recommended_plugins>"),
        ] {
            if remaining.starts_with(opening) {
                let Some(end) = remaining.find(closing) else {
                    return String::new();
                };
                remaining = &remaining[end + closing.len()..];
                removed_block = true;
                break;
            }
        }
        if !removed_block {
            return remaining.trim().to_owned();
        }
    }
}

fn deduplicate_mirrored_messages(messages: &mut Vec<MessageCandidate>) {
    messages.sort_by_key(|message| message.order);
    let mut deduplicated = Vec::<MessageCandidate>::with_capacity(messages.len());
    for message in messages.drain(..) {
        let mirrored = deduplicated.last().is_some_and(|previous| {
            previous.role == message.role
                && previous.text == message.text
                && previous.preferred != message.preferred
                && message.order.saturating_sub(previous.order) <= 2
        });
        if mirrored {
            // Preserve the earlier position for conversation ordering while
            // remembering that the pair had the preferred event form.
            if message.preferred {
                if let Some(previous) = deduplicated.last_mut() {
                    previous.preferred = true;
                }
            }
        } else {
            deduplicated.push(message);
        }
    }
    *messages = deduplicated;
}

fn extract_message_content(message: &Value) -> Option<String> {
    let content = message.get("content")?;
    let mut parts = Vec::new();
    collect_text_parts(content, &mut parts);
    let text = parts.join("\n");
    (!text.trim().is_empty()).then_some(text)
}

fn collect_text_parts(value: &Value, output: &mut Vec<String>) {
    match value {
        Value::String(text) => output.push(text.clone()),
        Value::Array(items) => {
            for item in items {
                collect_text_parts(item, output);
            }
        }
        Value::Object(object) => {
            if let Some(text) = object.get("text").and_then(Value::as_str) {
                output.push(text.to_owned());
            } else if let Some(text) = object.get("message").and_then(Value::as_str) {
                output.push(text.to_owned());
            } else if let Some(content) = object.get("content") {
                collect_text_parts(content, output);
            }
        }
        _ => {}
    }
}

fn is_control_message(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.starts_with("<turn_aborted>") || trimmed.starts_with("<task_interrupted>")
}

fn clean_title(text: &str) -> String {
    let text = strip_leading_environment_context(text);
    let first_line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default()
        .trim_start_matches(|character: char| {
            matches!(character, '#' | '>' | '-' | '*' | '•') || character.is_whitespace()
        });
    let collapsed = first_line.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate_chars(&collapsed, 120)
}

fn is_placeholder_title(text: &str) -> bool {
    matches!(
        text.trim().to_ascii_lowercase().as_str(),
        "untitled session" | "untitled"
    )
}

fn strip_leading_environment_context(mut text: &str) -> &str {
    loop {
        let trimmed = text.trim_start();
        let Some(rest) = trimmed.strip_prefix("<environment_context>") else {
            return trimmed;
        };
        let Some(end) = rest.find("</environment_context>") else {
            return trimmed;
        };
        text = &rest[end + "</environment_context>".len()..];
    }
}

fn truncate_chars(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    let mut result = text
        .chars()
        .take(limit.saturating_sub(1))
        .collect::<String>();
    result.push('…');
    result
}

fn string_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    })
}

fn timestamp_value(value: &Value) -> Option<i64> {
    if let Some(number) = value.as_i64() {
        return Some(normalize_epoch(number));
    }
    if let Some(number) = value.as_u64() {
        return Some(normalize_epoch(saturating_i64(number)));
    }
    let text = value.as_str()?.trim();
    if let Ok(number) = text.parse::<i64>() {
        return Some(normalize_epoch(number));
    }
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|timestamp| timestamp.timestamp())
}

fn normalize_epoch(value: i64) -> i64 {
    let magnitude = value.unsigned_abs();
    if magnitude >= 100_000_000_000_000_000 {
        value / 1_000_000_000
    } else if magnitude >= 100_000_000_000_000 {
        value / 1_000_000
    } else if magnitude >= 100_000_000_000 {
        value / 1_000
    } else {
        value
    }
}

fn update_time_bounds(timestamp: i64, earliest: &mut Option<i64>, latest: &mut Option<i64>) {
    *earliest = Some(earliest.map_or(timestamp, |current| current.min(timestamp)));
    *latest = Some(latest.map_or(timestamp, |current| current.max(timestamp)));
}

fn trim_jsonl_line(mut line: &[u8]) -> &[u8] {
    while line
        .last()
        .is_some_and(|byte| matches!(byte, b'\n' | b'\r'))
    {
        line = &line[..line.len() - 1];
    }
    line
}

fn fallback_session_id(path: &Path) -> String {
    static UUID_PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = UUID_PATTERN.get_or_init(|| {
        Regex::new(r"(?i)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})")
            .expect("the UUID filename regex is valid")
    });
    if let Some(id) = path
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| pattern.captures(name))
        .and_then(|captures| captures.get(1))
    {
        return id.as_str().to_ascii_lowercase();
    }

    let hash = Sha256::digest(path_to_string(path).as_bytes());
    format!("path-{}", &hex::encode(hash)[..32])
}

fn metadata_modified_ns(metadata_json: &str) -> Option<u128> {
    let value = serde_json::from_str::<Value>(metadata_json).ok()?;
    let modified = value.get("_index")?.get("fileModifiedNs")?;
    modified
        .as_str()
        .and_then(|value| value.parse::<u128>().ok())
        .or_else(|| modified.as_u64().map(u128::from))
}

fn metadata_index_version(metadata_json: &str) -> Option<u32> {
    serde_json::from_str::<Value>(metadata_json)
        .ok()?
        .get("_index")?
        .get("formatVersion")?
        .as_u64()
        .and_then(|value| u32::try_from(value).ok())
}

fn make_preview(title: &str, content: &str, query: &str) -> (String, Vec<TextRange>) {
    if query.is_empty() {
        let source = if content.trim().is_empty() {
            title
        } else {
            content
        };
        return (excerpt_start(source, PREVIEW_CHAR_LIMIT), Vec::new());
    }

    // The DTO has one range collection, defined relative to `preview`. A title
    // hit therefore uses the title itself as preview, even when the same text
    // also appears at the start of the indexed body.
    if first_match(title, query).is_some() {
        let preview = excerpt_start(title, PREVIEW_CHAR_LIMIT);
        let ranges = find_match_ranges(&preview, query);
        return (preview, ranges);
    }
    if let Some((start, end)) = first_match(content, query) {
        let preview = excerpt_around(content, start, end, PREVIEW_CHAR_LIMIT);
        let ranges = find_match_ranges(&preview, query);
        return (preview, ranges);
    }

    let source = if content.trim().is_empty() {
        title
    } else {
        content
    };
    (excerpt_start(source, PREVIEW_CHAR_LIMIT), Vec::new())
}

fn excerpt_start(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    let end = byte_at_char(text, limit.saturating_sub(1));
    format!("{}…", &text[..end])
}

fn excerpt_around(text: &str, match_start: usize, match_end: usize, limit: usize) -> String {
    let boundaries = character_boundaries(text);
    let start_character = boundary_position(&boundaries, match_start);
    let end_character = boundary_position(&boundaries, match_end);
    let match_length = end_character.saturating_sub(start_character);
    let window = limit.max(match_length);
    let mut first_character = start_character.saturating_sub(PREVIEW_CONTEXT_BEFORE);
    let mut last_character = (first_character + window).min(boundaries.len() - 1);
    if last_character < end_character {
        last_character = end_character;
        first_character = last_character.saturating_sub(window);
    }

    let mut preview = String::new();
    if first_character > 0 {
        preview.push('…');
    }
    preview.push_str(&text[boundaries[first_character]..boundaries[last_character]]);
    if last_character < boundaries.len() - 1 {
        preview.push('…');
    }
    preview
}

fn character_boundaries(text: &str) -> Vec<usize> {
    let mut boundaries = text
        .char_indices()
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if boundaries.first().copied() != Some(0) {
        boundaries.insert(0, 0);
    }
    if boundaries.last().copied() != Some(text.len()) {
        boundaries.push(text.len());
    }
    boundaries
}

fn boundary_position(boundaries: &[usize], byte_index: usize) -> usize {
    match boundaries.binary_search(&byte_index) {
        Ok(position) => position,
        Err(position) => position.saturating_sub(1),
    }
}

fn byte_at_char(text: &str, character: usize) -> usize {
    text.char_indices()
        .nth(character)
        .map(|(index, _)| index)
        .unwrap_or(text.len())
}

fn first_match(text: &str, query: &str) -> Option<(usize, usize)> {
    literal_regex(query)
        .and_then(|regex| regex.find(text).map(|found| (found.start(), found.end())))
        .or_else(|| {
            text.find(query)
                .map(|start| (start, start.saturating_add(query.len())))
        })
}

fn find_match_ranges(text: &str, query: &str) -> Vec<TextRange> {
    if query.is_empty() {
        return Vec::new();
    }
    let Some(regex) = literal_regex(query) else {
        return text
            .match_indices(query)
            .map(|(start, value)| utf16_range(text, start, start + value.len()))
            .collect();
    };
    regex
        .find_iter(text)
        .map(|found| utf16_range(text, found.start(), found.end()))
        .collect()
}

fn literal_regex(query: &str) -> Option<Regex> {
    RegexBuilder::new(&regex::escape(query))
        .case_insensitive(true)
        .unicode(true)
        .build()
        .ok()
}

fn utf16_range(text: &str, start: usize, end: usize) -> TextRange {
    TextRange {
        start: text[..start].encode_utf16().count(),
        end: text[..end].encode_utf16().count(),
    }
}

fn fts_literal_query(query: &str) -> String {
    format!("\"{}\"", query.replace('"', "\"\""))
}

fn like_contains_pattern(query: &str) -> String {
    let mut escaped = String::with_capacity(query.len() + 2);
    escaped.push('%');
    for character in query.chars() {
        if matches!(character, '%' | '_' | '\\') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped.push('%');
    escaped
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn saturating_i64(value: impl Into<u128>) -> i64 {
    let value = value.into();
    value.min(i64::MAX as u128) as i64
}

#[cfg(test)]
mod tests {
    use std::{fs, thread, time::Duration};

    use serde_json::json;
    use tempfile::TempDir;

    use super::*;

    fn write_jsonl(path: &Path, values: &[Value], malformed: bool) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut body = values
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        if malformed {
            body.push_str("\n{not-json");
        }
        body.push('\n');
        fs::write(path, body).unwrap();
    }

    fn session_values(id: &str, cwd: &str, user: &str, assistant: &str) -> Vec<Value> {
        vec![
            json!({
                "timestamp": "2026-07-12T01:02:03Z",
                "type": "session_meta",
                "payload": {
                    "id": id,
                    "timestamp": "2026-07-12T01:02:03Z",
                    "cwd": cwd,
                    "cli_version": "1.2.3",
                    "model_provider": "openai"
                }
            }),
            // Modern rollouts contain this response_item/event_msg pair. Only
            // the preferred event representation should reach indexed content.
            json!({
                "timestamp": "2026-07-12T01:03:00Z",
                "type": "response_item",
                "payload": {"type": "message", "role": "user", "content": [
                    {"type": "input_text", "text": user}
                ]}
            }),
            json!({
                "timestamp": "2026-07-12T01:03:00Z",
                "type": "event_msg",
                "payload": {"type": "user_message", "message": user}
            }),
            json!({
                "timestamp": "2026-07-12T01:04:00Z",
                "type": "event_msg",
                "payload": {"type": "agent_message", "message": assistant}
            }),
            json!({
                "timestamp": "2026-07-12T01:04:00Z",
                "type": "response_item",
                "payload": {"type": "message", "role": "assistant", "content": [
                    {"type": "output_text", "text": assistant}
                ]}
            }),
        ]
    }

    fn desktop_session_values(
        session_id: &str,
        record_id: &str,
        thread_source: &str,
        cwd: &str,
        user: &str,
        assistant: &str,
    ) -> Vec<Value> {
        let mut values = session_values(record_id, cwd, user, assistant);
        let metadata = values[0]["payload"].as_object_mut().unwrap();
        metadata.insert("session_id".into(), Value::String(session_id.into()));
        metadata.insert("thread_source".into(), Value::String(thread_source.into()));
        values
    }

    fn request(query: &str) -> SessionSearchRequest {
        SessionSearchRequest {
            query: query.to_owned(),
            archived: None,
            cwd: None,
            limit: None,
            offset: None,
        }
    }

    #[test]
    fn parses_modern_rollout_and_tolerates_bad_lines() {
        let temp = TempDir::new().unwrap();
        let path = temp
            .path()
            .join("sessions/2026/07/12/rollout-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
        write_jsonl(
            &path,
            &session_values(
                "session-one",
                "D:/workspace",
                "构建 Codex Skills 管理器",
                "已经完成架构设计。",
            ),
            true,
        );
        let metadata = fs::metadata(&path).unwrap();
        let parsed = parse_session_file(&FileCandidate {
            path,
            archived: false,
            fingerprint: fingerprint(&metadata).unwrap(),
        })
        .unwrap();

        assert_eq!(parsed.session_id, "session-one");
        assert_eq!(parsed.cwd.as_deref(), Some("D:/workspace"));
        assert_eq!(parsed.title, "构建 Codex Skills 管理器");
        assert_eq!(parsed.content.matches("构建 Codex").count(), 1);
        assert_eq!(parsed.content.matches("已经完成").count(), 1);
        assert_eq!(parsed.created_at, 1_783_818_123);
        assert_eq!(parsed.updated_at, 1_783_818_240);
        assert_eq!(parsed.parse_status, "partial");
        assert!(parsed.parse_error.as_deref().unwrap().contains("line 6"));
        assert_eq!(
            metadata_index_version(&parsed.metadata_json),
            Some(SESSION_INDEX_FORMAT_VERSION)
        );
    }

    #[test]
    fn desktop_context_does_not_become_a_session_title_or_preview() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("sessions/desktop-context.jsonl");
        let values = vec![
            json!({
                "timestamp": "2026-07-12T01:00:00Z",
                "type": "session_meta",
                "payload": {"session_id": "desktop", "id": "desktop", "thread_source": "user", "cwd": "/work"}
            }),
            json!({
                "type": "response_item",
                "payload": {"type": "message", "role": "user", "content": [
                    {"type": "input_text", "text": "<recommended_plugins>internal list</recommended_plugins>"}
                ]}
            }),
            json!({
                "type": "response_item",
                "payload": {"type": "message", "role": "user", "content": [
                    {"type": "input_text", "text": "<environment_context><cwd>/work</cwd></environment_context>"}
                ]}
            }),
            json!({
                "type": "response_item",
                "payload": {"type": "message", "role": "user", "content": [
                    {"type": "input_text", "text": "为客户会议生成项目周报"}
                ]}
            }),
            json!({
                "type": "response_item",
                "payload": {"type": "message", "role": "assistant", "content": [
                    {"type": "output_text", "text": "已整理周报结构。"}
                ]}
            }),
        ];
        write_jsonl(&path, &values, false);
        let metadata = fs::metadata(&path).unwrap();
        let parsed = parse_session_file(&FileCandidate {
            path,
            archived: false,
            fingerprint: fingerprint(&metadata).unwrap(),
        })
        .unwrap();

        assert_eq!(parsed.title, "为客户会议生成项目周报");
        assert_eq!(parsed.content, "为客户会议生成项目周报\n\n已整理周报结构。");
    }

    #[test]
    fn mixed_format_rollout_keeps_old_history_and_only_deduplicates_mirrors() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("sessions/mixed.jsonl");
        let values = vec![
            json!({
                "timestamp": "2026-07-12T01:00:00Z",
                "type": "session_meta",
                "payload": {"id": "mixed", "cwd": "/work/mixed"}
            }),
            json!({
                "timestamp": "2026-07-12T01:01:00Z",
                "type": "response_item",
                "payload": {"type": "message", "role": "user", "content": [
                    {"type": "input_text", "text": "升级前的问题"}
                ]}
            }),
            json!({
                "timestamp": "2026-07-12T01:02:00Z",
                "type": "response_item",
                "payload": {"type": "message", "role": "assistant", "content": [
                    {"type": "output_text", "text": "升级前的回答"}
                ]}
            }),
            json!({
                "timestamp": "2026-07-12T01:03:00Z",
                "type": "response_item",
                "payload": {"type": "message", "role": "user", "content": [
                    {"type": "input_text", "text": "升级后的问题"}
                ]}
            }),
            json!({
                "timestamp": "2026-07-12T01:03:00Z",
                "type": "event_msg",
                "payload": {"type": "user_message", "message": "升级后的问题"}
            }),
            json!({
                "timestamp": "2026-07-12T01:04:00Z",
                "type": "event_msg",
                "payload": {"type": "agent_message", "message": "升级后的回答"}
            }),
            json!({
                "timestamp": "2026-07-12T01:04:00Z",
                "type": "response_item",
                "payload": {"type": "message", "role": "assistant", "content": [
                    {"type": "output_text", "text": "升级后的回答"}
                ]}
            }),
        ];
        write_jsonl(&path, &values, false);
        let metadata = fs::metadata(&path).unwrap();
        let parsed = parse_session_file(&FileCandidate {
            path,
            archived: false,
            fingerprint: fingerprint(&metadata).unwrap(),
        })
        .unwrap();

        assert_eq!(parsed.title, "升级前的问题");
        assert_eq!(
            parsed.content,
            "升级前的问题\n\n升级前的回答\n\n升级后的问题\n\n升级后的回答"
        );
    }

    #[test]
    fn indexing_is_incremental_and_reconciles_archived_and_deleted_files() {
        let codex_home = TempDir::new().unwrap();
        let app_data = TempDir::new().unwrap();
        let database = Database::open(app_data.path()).unwrap();
        let active = codex_home.path().join("sessions/active.jsonl");
        let archived = codex_home.path().join("archived_sessions/old.jsonl");
        write_jsonl(
            &active,
            &session_values("active", "/work/a", "当前会话", "正文"),
            false,
        );
        write_jsonl(
            &archived,
            &session_values("archived", "/work/b", "历史会话", "旧正文"),
            false,
        );

        assert_eq!(
            index_codex_sessions_in(&database, codex_home.path()).unwrap(),
            2
        );
        assert_eq!(
            index_codex_sessions_in(&database, codex_home.path()).unwrap(),
            0
        );

        let mut archived_request = request("");
        archived_request.archived = Some(true);
        let archived_rows = search_sessions(&database, &archived_request).unwrap();
        assert_eq!(archived_rows.len(), 1);
        assert_eq!(archived_rows[0].id, "archived");

        // Ensure a new file fingerprint is observable on coarse filesystems.
        thread::sleep(Duration::from_millis(5));
        write_jsonl(
            &active,
            &session_values("active", "/work/a", "当前会话已更新", "更多正文内容"),
            false,
        );
        assert_eq!(
            index_codex_sessions_in(&database, codex_home.path()).unwrap(),
            1
        );
        assert_eq!(
            get_session(&database, "active").unwrap().summary.title,
            "当前会话已更新"
        );

        fs::remove_file(archived).unwrap();
        assert_eq!(
            index_codex_sessions_in(&database, codex_home.path()).unwrap(),
            1
        );
        assert!(matches!(
            get_session(&database, "archived"),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn duplicate_session_id_prefers_active_stably_then_converts_after_move() {
        let codex_home = TempDir::new().unwrap();
        let app_data = TempDir::new().unwrap();
        let database = Database::open(app_data.path()).unwrap();
        let active = codex_home.path().join("sessions").join("live-copy.jsonl");
        let archived = codex_home
            .path()
            .join("archived_sessions")
            .join("archive-copy.jsonl");
        write_jsonl(
            &active,
            &session_values("duplicate-id", "/work/dup", "活跃副本", "活跃内容"),
            false,
        );
        write_jsonl(
            &archived,
            &session_values("duplicate-id", "/work/dup", "归档副本", "归档内容"),
            false,
        );

        assert_eq!(
            index_codex_sessions_in(&database, codex_home.path()).unwrap(),
            1
        );
        let detail = get_session(&database, "duplicate-id").unwrap();
        assert!(!detail.summary.archived);
        assert_eq!(detail.summary.title, "活跃副本");
        assert_eq!(detail.file_path, path_to_string(&active));

        assert_eq!(
            index_codex_sessions_in(&database, codex_home.path()).unwrap(),
            0
        );
        assert!(
            !get_session(&database, "duplicate-id")
                .unwrap()
                .summary
                .archived
        );

        // A newer archived copy must still not displace an existing active one.
        write_jsonl(
            &archived,
            &session_values(
                "duplicate-id",
                "/work/dup",
                "更新后的归档副本",
                "更新后的归档内容",
            ),
            false,
        );
        assert_eq!(
            index_codex_sessions_in(&database, codex_home.path()).unwrap(),
            0
        );
        assert_eq!(
            get_session(&database, "duplicate-id")
                .unwrap()
                .summary
                .title,
            "活跃副本"
        );

        // Once the active file is gone, the remaining archived copy becomes
        // authoritative and updates the same logical database row.
        fs::remove_file(&active).unwrap();
        assert_eq!(
            index_codex_sessions_in(&database, codex_home.path()).unwrap(),
            1
        );
        let detail = get_session(&database, "duplicate-id").unwrap();
        assert!(detail.summary.archived);
        assert_eq!(detail.summary.title, "更新后的归档副本");
        assert_eq!(detail.file_path, path_to_string(&archived));
    }

    #[test]
    fn indexes_user_thread_and_discards_subagent_rollouts() {
        let codex_home = TempDir::new().unwrap();
        let app_data = TempDir::new().unwrap();
        let database = Database::open(app_data.path()).unwrap();
        let main = codex_home.path().join("sessions/main.jsonl");
        let subagent = codex_home.path().join("sessions/subagent.jsonl");
        write_jsonl(
            &main,
            &desktop_session_values(
                "user-thread",
                "user-thread",
                "user",
                "/work",
                "设计 Skills 生成流程",
                "主线程回答",
            ),
            false,
        );
        write_jsonl(
            &subagent,
            &desktop_session_values(
                "user-thread",
                "subagent-run",
                "subagent",
                "/work",
                "<environment_context>internal</environment_context>",
                "内部工具结果",
            ),
            false,
        );

        assert_eq!(
            index_codex_sessions_in(&database, codex_home.path()).unwrap(),
            1
        );
        assert_eq!(
            get_session(&database, "user-thread").unwrap().summary.title,
            "设计 Skills 生成流程"
        );
        assert!(matches!(
            get_session(&database, "subagent-run"),
            Err(AppError::NotFound(_))
        ));
        assert_eq!(search_sessions(&database, &request("")).unwrap().len(), 1);
    }

    #[test]
    fn searches_empty_short_and_trigram_queries_with_filters() {
        let codex_home = TempDir::new().unwrap();
        let app_data = TempDir::new().unwrap();
        let database = Database::open(app_data.path()).unwrap();
        write_jsonl(
            &codex_home.path().join("sessions/one.jsonl"),
            &session_values(
                "one",
                "/work/a",
                "搜索测试",
                "😀前缀后是中文标题及正文子串检索，并且含高亮。",
            ),
            false,
        );
        write_jsonl(
            &codex_home.path().join("archived_sessions/two.jsonl"),
            &session_values("two", "/work/b", "另一个会话", "没有相关内容"),
            false,
        );
        index_codex_sessions_in(&database, codex_home.path()).unwrap();

        assert_eq!(search_sessions(&database, &request("")).unwrap().len(), 2);

        let short = search_sessions(&database, &request("中")).unwrap();
        assert_eq!(short.len(), 1);
        let range = &short[0].match_ranges[0];
        assert_eq!(
            &short[0].preview.encode_utf16().collect::<Vec<_>>()[range.start..range.end],
            &[0x4e2d]
        );

        let trigram = search_sessions(&database, &request("正文子串")).unwrap();
        assert_eq!(trigram.len(), 1);
        assert!(!trigram[0].match_ranges.is_empty());

        let mut filtered = request("");
        filtered.cwd = Some("/work/b".into());
        filtered.archived = Some(true);
        let filtered_rows = search_sessions(&database, &filtered).unwrap();
        assert_eq!(filtered_rows.len(), 1);
        assert_eq!(filtered_rows[0].id, "two");
    }

    #[test]
    fn cwd_filter_includes_descendants_without_matching_siblings() {
        let codex_home = TempDir::new().unwrap();
        let app_data = TempDir::new().unwrap();
        let database = Database::open(app_data.path()).unwrap();

        #[cfg(target_os = "windows")]
        let (root, exact, child, sibling) = (
            r"D:\Work\Repo\",
            r"D:\Work\Repo",
            r"d:/work/repo/packages/app",
            r"D:\Work\Repository",
        );
        #[cfg(not(target_os = "windows"))]
        let (root, exact, child, sibling) = (
            "/work/repo/",
            "/work/repo",
            "/work/repo/packages/app",
            "/work/repository",
        );

        for (id, cwd) in [("exact", exact), ("child", child), ("sibling", sibling)] {
            write_jsonl(
                &codex_home.path().join(format!("sessions/{id}.jsonl")),
                &session_values(id, cwd, id, "content"),
                false,
            );
        }
        index_codex_sessions_in(&database, codex_home.path()).unwrap();

        let mut filtered = request("");
        filtered.cwd = Some(root.into());
        let rows = search_sessions(&database, &filtered).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().any(|session| session.id == "exact"));
        assert!(rows.iter().any(|session| session.id == "child"));
        assert!(!rows.iter().any(|session| session.id == "sibling"));
    }

    #[test]
    fn title_only_matches_use_title_as_preview_and_utf16_offsets() {
        let stored = StoredSession {
            id: "id".into(),
            title: "😀Skills Manager".into(),
            content: "unrelated body".into(),
            cwd: None,
            created_at: 0,
            updated_at: 0,
            archived: false,
            source_kind: "codex".into(),
            title_origin: "derived".into(),
            can_rename: false,
        };
        let summary = stored.into_summary("Skills");
        assert_eq!(summary.preview, "😀Skills Manager");
        assert_eq!(summary.match_ranges.len(), 1);
        assert_eq!(summary.match_ranges[0].start, 2);
        assert_eq!(summary.match_ranges[0].end, 8);
    }

    #[test]
    fn fallback_id_uses_uuid_in_filename() {
        let id = fallback_session_id(Path::new(
            "/tmp/rollout-2026-01-01T00-00-00-019f5bee-b0a3-72a2-9025-bfe194b8c3b1.jsonl",
        ));
        assert_eq!(id, "019f5bee-b0a3-72a2-9025-bfe194b8c3b1");
    }
}
