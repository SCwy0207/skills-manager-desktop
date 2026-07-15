use std::{
    collections::HashMap,
    env,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use chrono::DateTime;
use rusqlite::{
    params, types::Value as SqlValue, Connection, OpenFlags, OptionalExtension, TransactionBehavior,
};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

use crate::error::{AppError, AppResult};

const TITLE_CHAR_LIMIT: usize = 120;
const CLAUDE_SOURCE: &str = "claude";
const CURSOR_SOURCE: &str = "cursor";

/// A source-neutral session ready to be upserted into the shared `sessions`
/// table. External IDs are namespaced so equal UUIDs from different agents do
/// not collide.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AdapterSession {
    pub session_id: String,
    pub native_session_id: String,
    pub title: String,
    pub title_origin: String,
    pub can_rename: bool,
    pub content: String,
    /// Unique index locator. For stores that contain many sessions (Cursor's
    /// SQLite database), this includes a synthetic fragment.
    pub file_path: String,
    /// Physical file that the native agent reads and that rename must mutate.
    pub native_store_path: String,
    pub cwd: Option<String>,
    pub source_kind: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived: bool,
    pub content_hash: String,
    pub file_size: i64,
    pub parse_status: String,
    pub parse_error: Option<String>,
    pub metadata_json: String,
}

#[derive(Debug, Default)]
pub(crate) struct AdapterScan {
    pub sessions: Vec<AdapterSession>,
    /// A source is complete only when its authoritative root was traversed and
    /// parsed without an I/O/schema failure. Callers may safely reconcile stale
    /// rows only for the sources in this list.
    pub completed_sources: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone)]
struct VisibleMessage {
    role: Role,
    text: String,
}

#[derive(Debug)]
struct CursorTranscript {
    messages: Vec<VisibleMessage>,
    path: PathBuf,
    project_key: Option<String>,
    updated_at: i64,
}

#[derive(Debug)]
struct CursorPatch {
    database: PathBuf,
    table: &'static str,
    key: String,
    original: SqlValue,
    updated: SqlValue,
}

/// Scans the standard local storage roots for Claude Code and Cursor. A broken
/// or unsupported source does not hide healthy sessions from the other source;
/// it is reported as a warning and omitted from `completed_sources`.
pub(crate) fn scan_external_sessions() -> AppResult<AdapterScan> {
    let mut scan = AdapterScan::default();

    let claude_root = env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".claude")))
        .map(|root| root.join("projects"));
    match claude_root {
        Some(root) => match scan_claude_projects(&root) {
            Ok(sessions) => {
                scan.sessions.extend(sessions);
                scan.completed_sources.push(CLAUDE_SOURCE.to_owned());
            }
            Err(error) => scan
                .warnings
                .push(format!("Claude session scan was incomplete: {error}")),
        },
        None => scan
            .warnings
            .push("Claude session scan could not determine the home directory".to_owned()),
    }

    let cursor_user = dirs::config_dir().map(|config| config.join("Cursor").join("User"));
    let cursor_projects = dirs::home_dir().map(|home| home.join(".cursor").join("projects"));
    match (cursor_user, cursor_projects) {
        (Some(user), Some(projects)) => {
            let database = user.join("globalStorage").join("state.vscdb");
            match scan_cursor_storage(&database, &projects) {
                Ok(sessions) => {
                    scan.sessions.extend(sessions);
                    scan.completed_sources.push(CURSOR_SOURCE.to_owned());
                }
                Err(error) => scan
                    .warnings
                    .push(format!("Cursor session scan was incomplete: {error}")),
            }
        }
        _ => scan
            .warnings
            .push("Cursor session scan could not determine the local storage roots".to_owned()),
    }

    Ok(scan)
}

/// Scans Claude Code transcripts below `~/.claude/projects`. Subagent
/// transcripts are deliberately excluded because they are not entries in the
/// native session picker.
pub(crate) fn scan_claude_projects(projects_root: &Path) -> AppResult<Vec<AdapterSession>> {
    if !projects_root.exists() {
        return Ok(Vec::new());
    }

    let mut sessions = HashMap::<String, AdapterSession>::new();
    for entry in WalkDir::new(projects_root).follow_links(false) {
        let entry = entry.map_err(|error| AppError::Io(error.into()))?;
        if !entry.file_type().is_file()
            || entry
                .path()
                .extension()
                .and_then(|extension| extension.to_str())
                .is_none_or(|extension| !extension.eq_ignore_ascii_case("jsonl"))
            || entry
                .path()
                .components()
                .any(|component| component.as_os_str() == "subagents")
        {
            continue;
        }

        let Some(session) = parse_claude_transcript(entry.path())? else {
            continue;
        };
        let replace = sessions
            .get(&session.native_session_id)
            .is_none_or(|current| session.updated_at > current.updated_at);
        if replace {
            sessions.insert(session.native_session_id.clone(), session);
        }
    }

    let mut sessions = sessions.into_values().collect::<Vec<_>>();
    sessions.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
    Ok(sessions)
}

fn parse_claude_transcript(path: &Path) -> AppResult<Option<AdapterSession>> {
    let metadata = fs::metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Ok(None);
    }
    let fallback_time = modified_seconds(&metadata);
    let mut reader = BufReader::new(File::open(path)?);
    let mut raw = Vec::new();
    let mut hasher = Sha256::new();
    let mut native_id = None::<String>;
    let mut conflicting_id = false;
    let mut cwd = None::<String>;
    let mut custom_title = None::<String>;
    let mut ai_title = None::<String>;
    let mut summary = None::<String>;
    let mut agent_name = None::<String>;
    let mut messages = Vec::<VisibleMessage>::new();
    let mut earliest = None::<i64>;
    let mut latest = None::<i64>;
    let mut valid_lines = 0usize;
    let mut malformed_lines = 0usize;
    let mut line_count = 0usize;
    let mut is_sidechain = false;

    loop {
        raw.clear();
        let read = reader.read_until(b'\n', &mut raw)?;
        if read == 0 {
            break;
        }
        line_count += 1;
        hasher.update(&raw);
        let bytes = trim_jsonl_line(&raw);
        if bytes.is_empty() {
            continue;
        }
        let value = match serde_json::from_slice::<Value>(bytes) {
            Ok(value) => value,
            Err(_) => {
                malformed_lines += 1;
                continue;
            }
        };
        valid_lines += 1;

        if value
            .get("isSidechain")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            is_sidechain = true;
        }
        if let Some(id) = string_field(&value, &["sessionId", "session_id"]) {
            match native_id.as_deref() {
                Some(current) if current != id => conflicting_id = true,
                None => native_id = Some(id.to_owned()),
                _ => {}
            }
        }
        if let Some(value_cwd) = string_field(&value, &["cwd"]) {
            cwd = Some(value_cwd.to_owned());
        }
        if let Some(timestamp) = value.get("timestamp").and_then(timestamp_value) {
            update_time_bounds(timestamp, &mut earliest, &mut latest);
        }

        match value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "custom-title" => {
                if let Some(title) = string_field(&value, &["customTitle"]) {
                    custom_title = Some(title.to_owned());
                }
            }
            "ai-title" => {
                if let Some(title) = string_field(&value, &["aiTitle"]) {
                    ai_title = Some(title.to_owned());
                }
            }
            "summary" => {
                if let Some(title) = string_field(&value, &["summary"]) {
                    summary = Some(title.to_owned());
                }
            }
            "agent-name" => {
                if let Some(title) = string_field(&value, &["agentName"]) {
                    agent_name = Some(title.to_owned());
                }
            }
            "user" => push_claude_message(&value, Role::User, &mut messages),
            "assistant" => push_claude_message(&value, Role::Assistant, &mut messages),
            _ => {}
        }
    }

    if is_sidechain || valid_lines == 0 {
        return Ok(None);
    }
    let filename_id = path.file_stem().and_then(|stem| stem.to_str());
    let native_id = native_id
        .or_else(|| filename_id.map(str::to_owned))
        .filter(|id| is_safe_native_id(id));
    let Some(native_id) = native_id else {
        return Ok(None);
    };
    let first_user = messages
        .iter()
        .find(|message| message.role == Role::User)
        .map(|message| message.text.as_str());
    let (title, title_origin) = if let Some(title) = custom_title.as_deref() {
        (clean_title(title), "custom")
    } else if let Some(title) = ai_title
        .as_deref()
        .or(summary.as_deref())
        .or(agent_name.as_deref())
    {
        (clean_title(title), "native")
    } else if let Some(prompt) = first_user {
        (clean_title(prompt), "derived")
    } else {
        ("Untitled session".to_owned(), "derived")
    };
    let content = messages
        .iter()
        .map(|message| message.text.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let created_at = earliest.unwrap_or(fallback_time);
    let updated_at = latest.unwrap_or(fallback_time).max(created_at);
    let can_rename = !conflicting_id
        && filename_id.is_some_and(|filename| filename == native_id)
        && messages.iter().any(|message| message.role == Role::User);
    let parse_status = match (malformed_lines, conflicting_id) {
        (0, false) => "ok",
        _ => "partial",
    };
    let parse_error = if conflicting_id {
        Some("conflicting sessionId values in Claude transcript".to_owned())
    } else if malformed_lines > 0 {
        Some(format!("{malformed_lines} malformed JSONL line(s)"))
    } else {
        None
    };
    let project_key = path
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str());
    let metadata_json = json!({
        "format": "claude-code-jsonl",
        "nativeStorePath": path_to_string(path),
        "projectKey": project_key,
        "lineCount": line_count,
        "validLineCount": valid_lines,
        "malformedLineCount": malformed_lines,
    })
    .to_string();

    Ok(Some(AdapterSession {
        session_id: namespaced_id(CLAUDE_SOURCE, &native_id),
        native_session_id: native_id,
        title: nonempty_title(title),
        title_origin: title_origin.to_owned(),
        can_rename,
        content,
        file_path: path_to_string(path),
        native_store_path: path_to_string(path),
        cwd,
        source_kind: CLAUDE_SOURCE.to_owned(),
        created_at,
        updated_at,
        archived: false,
        content_hash: hex::encode(hasher.finalize()),
        file_size: saturating_i64(metadata.len()),
        parse_status: parse_status.to_owned(),
        parse_error,
        metadata_json,
    }))
}

fn push_claude_message(value: &Value, role: Role, messages: &mut Vec<VisibleMessage>) {
    let Some(content) = value
        .get("message")
        .and_then(|message| message.get("content"))
    else {
        return;
    };
    let mut parts = Vec::new();
    collect_visible_text(content, &mut parts);
    let text = parts.join("\n").trim().to_owned();
    if !text.is_empty() {
        messages.push(VisibleMessage { role, text });
    }
}

/// Scans Cursor's modern `cursorDiskKV` store and joins any locally available
/// agent transcript for richer role-aware text. The database is opened
/// read-only and is safe to scan while Cursor is running.
pub(crate) fn scan_cursor_storage(
    global_database: &Path,
    projects_root: &Path,
) -> AppResult<Vec<AdapterSession>> {
    if !global_database.exists() {
        return Ok(Vec::new());
    }
    let transcripts = collect_cursor_transcripts(projects_root)?;
    let connection = Connection::open_with_flags(
        global_database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    if !sqlite_table_exists(&connection, "cursorDiskKV")? {
        return Err(AppError::Unsupported(
            "Cursor state database does not contain cursorDiskKV".to_owned(),
        ));
    }

    let database_metadata = fs::metadata(global_database)?;
    let database_updated = modified_seconds(&database_metadata);
    let mut statement = connection.prepare(
        "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%' ORDER BY key",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, SqlValue>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut sessions = Vec::new();

    for (key, raw) in rows {
        let Some(native_id) = key.strip_prefix("composerData:") else {
            continue;
        };
        if !is_safe_native_id(native_id) {
            continue;
        }
        let Ok(raw_bytes) = sql_value_bytes(&raw) else {
            continue;
        };
        let Ok(mut value) = serde_json::from_slice::<Value>(raw_bytes) else {
            continue;
        };
        let Some(object) = value.as_object_mut() else {
            continue;
        };
        let stored_id = object
            .get("composerId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let id_matches = stored_id == native_id;
        let transcript = transcripts.get(native_id);
        let bubbles = read_cursor_bubbles(&connection, native_id)?;
        let messages = if !bubbles.0.is_empty() {
            &bubbles.0
        } else {
            transcript
                .map(|transcript| &transcript.messages)
                .unwrap_or(&bubbles.0)
        };
        let custom_name = object
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty());
        let subtitle = object
            .get("subtitle")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty());
        let first_user = messages
            .iter()
            .find(|message| message.role == Role::User)
            .map(|message| message.text.as_str());
        let first_message = messages.first().map(|message| message.text.as_str());
        let (title, title_origin) = if let Some(name) = custom_name {
            (clean_title(name), "custom")
        } else if let Some(subtitle) = subtitle {
            (clean_title(subtitle), "native")
        } else if let Some(prompt) = first_user.or(first_message) {
            (clean_title(prompt), "derived")
        } else {
            ("Untitled session".to_owned(), "derived")
        };
        let content = messages
            .iter()
            .map(|message| message.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        let created_at = object
            .get("createdAt")
            .and_then(timestamp_value)
            .or(bubbles.1)
            .unwrap_or(database_updated);
        let updated_at = object
            .get("lastUpdatedAt")
            .and_then(timestamp_value)
            .or_else(|| transcript.map(|transcript| transcript.updated_at))
            .unwrap_or(database_updated)
            .max(created_at);
        let cwd = bubbles
            .2
            .or_else(|| find_cursor_workspace(object))
            .or_else(|| transcript.and_then(resolve_cursor_transcript_project));
        let transcript_path = transcript.map(|transcript| path_to_string(&transcript.path));
        let project_key = transcript.and_then(|transcript| transcript.project_key.as_deref());
        let mut content_hasher = Sha256::new();
        content_hasher.update(raw_bytes);
        content_hasher.update(content.as_bytes());
        let content_hash = hex::encode(content_hasher.finalize());
        let archived = object
            .get("isArchived")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let metadata_json = json!({
            "format": "cursor-disk-kv/composerData",
            "composerId": native_id,
            "nativeStorePath": path_to_string(global_database),
            "transcriptPath": transcript_path,
            "cursorProjectKey": project_key,
            "bubbleCount": messages.len(),
        })
        .to_string();

        sessions.push(AdapterSession {
            session_id: namespaced_id(CURSOR_SOURCE, native_id),
            native_session_id: native_id.to_owned(),
            title: nonempty_title(title),
            title_origin: title_origin.to_owned(),
            can_rename: id_matches,
            content,
            file_path: format!("{}#composer:{}", path_to_string(global_database), native_id),
            native_store_path: path_to_string(global_database),
            cwd,
            source_kind: CURSOR_SOURCE.to_owned(),
            created_at,
            updated_at,
            archived,
            content_hash,
            file_size: saturating_i64(raw_bytes.len() as u64),
            parse_status: if id_matches { "ok" } else { "partial" }.to_owned(),
            parse_error: (!id_matches)
                .then(|| "composerData key does not match composerId".to_owned()),
            metadata_json,
        });
    }

    sessions.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
    Ok(sessions)
}

fn collect_cursor_transcripts(root: &Path) -> AppResult<HashMap<String, CursorTranscript>> {
    if !root.exists() {
        return Ok(HashMap::new());
    }
    let mut transcripts = HashMap::<String, CursorTranscript>::new();
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = entry.map_err(|error| AppError::Io(error.into()))?;
        let path = entry.path();
        if !entry.file_type().is_file()
            || path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_none_or(|extension| !extension.eq_ignore_ascii_case("jsonl"))
        {
            continue;
        }
        let Some(native_id) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        let transcript_dir_matches = path
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == native_id);
        let agent_transcripts = path.ancestors().find(|ancestor| {
            ancestor
                .file_name()
                .is_some_and(|name| name == "agent-transcripts")
        });
        if !transcript_dir_matches || agent_transcripts.is_none() || !is_safe_native_id(native_id) {
            continue;
        }
        let messages = parse_cursor_transcript(path)?;
        let metadata = fs::metadata(path)?;
        let updated_at = modified_seconds(&metadata);
        let project_key = agent_transcripts
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            .map(str::to_owned);
        let replace = transcripts
            .get(native_id)
            .is_none_or(|current| updated_at > current.updated_at);
        if replace {
            transcripts.insert(
                native_id.to_owned(),
                CursorTranscript {
                    messages,
                    path: path.to_owned(),
                    project_key,
                    updated_at,
                },
            );
        }
    }
    Ok(transcripts)
}

fn parse_cursor_transcript(path: &Path) -> AppResult<Vec<VisibleMessage>> {
    let mut messages = Vec::new();
    for line in BufReader::new(File::open(path)?).lines() {
        let Ok(line) = line else { continue };
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let role = match value.get("role").and_then(Value::as_str) {
            Some("user" | "human") => Role::User,
            Some("assistant" | "ai") => Role::Assistant,
            _ => continue,
        };
        let content = value
            .get("message")
            .and_then(|message| message.get("content"))
            .or_else(|| value.get("content"));
        let Some(content) = content else { continue };
        let mut parts = Vec::new();
        collect_visible_text(content, &mut parts);
        let text = parts.join("\n").trim().to_owned();
        if !text.is_empty() {
            messages.push(VisibleMessage { role, text });
        }
    }
    Ok(messages)
}

fn read_cursor_bubbles(
    connection: &Connection,
    composer_id: &str,
) -> AppResult<(Vec<VisibleMessage>, Option<i64>, Option<String>)> {
    let prefix = format!("bubbleId:{composer_id}:%");
    let mut statement =
        connection.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE ?1 ORDER BY key")?;
    let rows = statement
        .query_map([prefix], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, SqlValue>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut ordered_messages = Vec::<(Option<i64>, String, VisibleMessage)>::new();
    let mut earliest = None;
    let mut latest = None;
    let mut cwd = None;
    for (key, raw) in rows {
        let Ok(raw_bytes) = sql_value_bytes(&raw) else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<Value>(raw_bytes) else {
            continue;
        };
        let timestamp = value.get("createdAt").and_then(timestamp_value);
        if let Some(timestamp) = timestamp {
            update_time_bounds(timestamp, &mut earliest, &mut latest);
        }
        cwd = cwd.or_else(|| find_cursor_workspace_value(&value));
        let role = match value.get("type") {
            Some(Value::Number(number)) if number.as_i64() == Some(1) => Role::User,
            Some(Value::Number(number)) if number.as_i64() == Some(2) => Role::Assistant,
            Some(Value::String(role)) if role == "user" || role == "human" => Role::User,
            Some(Value::String(role)) if role == "assistant" || role == "ai" => Role::Assistant,
            _ => continue,
        };
        let text = value
            .get("text")
            .or_else(|| value.get("richText"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty());
        if let Some(text) = text {
            ordered_messages.push((
                timestamp,
                key,
                VisibleMessage {
                    role,
                    text: text.to_owned(),
                },
            ));
        }
    }
    ordered_messages.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    let messages = ordered_messages
        .into_iter()
        .map(|(_, _, message)| message)
        .collect();
    Ok((messages, latest.or(earliest), cwd))
}

fn find_cursor_workspace(object: &Map<String, Value>) -> Option<String> {
    object.get("context").and_then(find_cursor_workspace_value)
}

fn find_cursor_workspace_value(value: &Value) -> Option<String> {
    if let Some(uris) = value.get("workspaceUris").and_then(Value::as_array) {
        for uri in uris {
            if let Some(path) = uri.as_str().and_then(file_uri_to_path) {
                return Some(path);
            }
        }
    }
    if let Some(folders) = value.get("folderSelections").and_then(Value::as_array) {
        for folder in folders {
            for key in ["uri", "path", "folderPath"] {
                if let Some(raw) = folder.get(key).and_then(Value::as_str) {
                    return file_uri_to_path(raw).or_else(|| Some(raw.to_owned()));
                }
            }
        }
    }
    match value {
        Value::Array(items) => items.iter().find_map(find_cursor_workspace_value),
        Value::Object(object) => object.values().find_map(find_cursor_workspace_value),
        _ => None,
    }
}

fn resolve_cursor_transcript_project(transcript: &CursorTranscript) -> Option<String> {
    let key = transcript.project_key.as_deref()?;
    if key.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }
    #[cfg(target_os = "windows")]
    {
        let mut characters = key.chars();
        let drive = characters.next()?;
        if !drive.is_ascii_alphabetic() || characters.next()? != '-' {
            return None;
        }
        let rest = characters.collect::<String>().replace('-', "\\");
        let candidate = PathBuf::from(format!("{}:\\{rest}", drive.to_ascii_uppercase()));
        candidate.exists().then(|| path_to_string(&candidate))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let candidate = PathBuf::from(format!("/{}", key.replace('-', "/")));
        candidate.exists().then(|| path_to_string(&candidate))
    }
}

/// Renames a supported external session in its native store.
/// `native_store_path` must be the physical source path recorded by the
/// adapter; caller-provided arbitrary paths are rejected by source-specific
/// structural checks.
pub(crate) fn rename_external_session(
    source_kind: &str,
    native_session_id: &str,
    native_store_path: &Path,
    new_title: &str,
) -> AppResult<()> {
    let title = validate_title(new_title)?;
    if !is_safe_native_id(native_session_id) {
        return Err(AppError::InvalidInput(
            "session native ID is invalid".to_owned(),
        ));
    }
    match source_kind {
        CLAUDE_SOURCE => rename_claude_session(native_store_path, native_session_id, title),
        CURSOR_SOURCE => rename_cursor_session(native_store_path, native_session_id, title),
        _ => Err(AppError::Unsupported(format!(
            "session source '{source_kind}' does not support native rename"
        ))),
    }
}

pub(crate) fn rename_claude_session(
    transcript: &Path,
    native_session_id: &str,
    new_title: &str,
) -> AppResult<()> {
    let title = validate_title(new_title)?;
    let metadata = fs::symlink_metadata(transcript)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || transcript.extension().and_then(|value| value.to_str()) != Some("jsonl")
        || transcript.file_stem().and_then(|value| value.to_str()) != Some(native_session_id)
    {
        return Err(AppError::Unsupported(
            "Claude transcript path does not match the supported session JSONL shape".to_owned(),
        ));
    }

    let mut saw_matching_id = false;
    let mut saw_conversation_record = false;
    for line in BufReader::new(File::open(transcript)?).lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let value = serde_json::from_str::<Value>(&line).map_err(|_| {
            AppError::Unsupported(
                "Claude transcript contains malformed JSONL; rename was not attempted".to_owned(),
            )
        })?;
        if let Some(id) = string_field(&value, &["sessionId", "session_id"]) {
            if id != native_session_id {
                return Err(AppError::Conflict(
                    "Claude transcript contains a different sessionId".to_owned(),
                ));
            }
            saw_matching_id = true;
        }
        if matches!(
            value.get("type").and_then(Value::as_str),
            Some("user" | "assistant")
        ) {
            saw_conversation_record = true;
        }
    }
    if !saw_matching_id || !saw_conversation_record {
        return Err(AppError::Unsupported(
            "Claude transcript lacks the required sessionId/conversation records".to_owned(),
        ));
    }

    let mut file = OpenOptions::new()
        .read(true)
        .append(true)
        .open(transcript)?;
    let length = file.metadata()?.len();
    let needs_newline = if length == 0 {
        false
    } else {
        file.seek(SeekFrom::End(-1))?;
        let mut byte = [0u8; 1];
        file.read_exact(&mut byte)?;
        byte[0] != b'\n'
    };
    let record = json!({
        "type": "custom-title",
        "customTitle": title,
        "sessionId": native_session_id,
    });
    let mut encoded = Vec::new();
    if needs_newline {
        encoded.push(b'\n');
    }
    serde_json::to_writer(&mut encoded, &record)
        .map_err(|error| AppError::Internal(error.to_string()))?;
    encoded.push(b'\n');
    file.write_all(&encoded)?;
    file.sync_data()?;
    Ok(())
}

pub(crate) fn rename_cursor_session(
    global_database: &Path,
    native_session_id: &str,
    new_title: &str,
) -> AppResult<()> {
    let title = validate_title(new_title)?;
    if global_database.file_name().and_then(|name| name.to_str()) != Some("state.vscdb")
        || global_database
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            != Some("globalStorage")
    {
        return Err(AppError::Unsupported(
            "Cursor database path is not a supported globalStorage/state.vscdb".to_owned(),
        ));
    }
    let mut patches = vec![cursor_global_patch(
        global_database,
        native_session_id,
        title,
    )?];
    if let Some(user_root) = global_database.parent().and_then(Path::parent) {
        let workspace_root = user_root.join("workspaceStorage");
        if workspace_root.exists() {
            for entry in WalkDir::new(&workspace_root)
                .min_depth(2)
                .max_depth(2)
                .follow_links(false)
            {
                let Ok(entry) = entry else { continue };
                if entry.file_type().is_file() && entry.file_name() == "state.vscdb" {
                    if let Some(patch) =
                        cursor_workspace_patch(entry.path(), native_session_id, title)?
                    {
                        patches.push(patch);
                    }
                }
            }
        }
    }

    let mut applied = Vec::<CursorPatch>::new();
    for patch in patches {
        if let Err(error) = apply_cursor_patch(&patch, false) {
            for completed in applied.iter().rev() {
                let _ = apply_cursor_patch(completed, true);
            }
            return Err(error);
        }
        applied.push(patch);
    }
    Ok(())
}

fn cursor_global_patch(
    database: &Path,
    native_session_id: &str,
    title: &str,
) -> AppResult<CursorPatch> {
    let connection = open_cursor_readonly(database)?;
    if !sqlite_table_exists(&connection, "cursorDiskKV")? {
        return Err(AppError::Unsupported(
            "Cursor state database does not contain cursorDiskKV".to_owned(),
        ));
    }
    let key = format!("composerData:{native_session_id}");
    let original = connection
        .query_row(
            "SELECT value FROM cursorDiskKV WHERE key = ?1",
            [&key],
            |row| row.get::<_, SqlValue>(0),
        )
        .optional()?
        .ok_or_else(|| {
            AppError::NotFound(format!(
                "Cursor composer '{native_session_id}' was not found"
            ))
        })?;
    let mut value = parse_cursor_composer(sql_value_bytes(&original)?, native_session_id)?;
    value
        .as_object_mut()
        .expect("parse_cursor_composer guarantees an object")
        .insert("name".to_owned(), Value::String(title.to_owned()));
    let updated = json_sql_value_like(&original, &value)?;
    Ok(CursorPatch {
        database: database.to_owned(),
        table: "cursorDiskKV",
        key,
        original,
        updated,
    })
}

fn cursor_workspace_patch(
    database: &Path,
    native_session_id: &str,
    title: &str,
) -> AppResult<Option<CursorPatch>> {
    let connection = match open_cursor_readonly(database) {
        Ok(connection) => connection,
        Err(_) => return Ok(None),
    };
    if !sqlite_table_exists(&connection, "ItemTable")? {
        return Ok(None);
    }
    let key = "composer.composerData".to_owned();
    let Some(original) = connection
        .query_row(
            "SELECT value FROM ItemTable WHERE key = ?1",
            [&key],
            |row| row.get::<_, SqlValue>(0),
        )
        .optional()?
    else {
        return Ok(None);
    };
    let Ok(original_bytes) = sql_value_bytes(&original) else {
        return Ok(None);
    };
    let Ok(mut value) = serde_json::from_slice::<Value>(original_bytes) else {
        return Ok(None);
    };
    let Some(composers) = value.get_mut("allComposers").and_then(Value::as_array_mut) else {
        return Ok(None);
    };
    let mut matched = false;
    for composer in composers {
        if composer.get("composerId").and_then(Value::as_str) == Some(native_session_id) {
            let Some(object) = composer.as_object_mut() else {
                continue;
            };
            object.insert("name".to_owned(), Value::String(title.to_owned()));
            matched = true;
        }
    }
    if !matched {
        return Ok(None);
    }
    let updated = json_sql_value_like(&original, &value)?;
    Ok(Some(CursorPatch {
        database: database.to_owned(),
        table: "ItemTable",
        key,
        original,
        updated,
    }))
}

fn apply_cursor_patch(patch: &CursorPatch, reverse: bool) -> AppResult<()> {
    let mut connection = Connection::open_with_flags(
        &patch.database,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(std::time::Duration::from_secs(2))?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let (expected, replacement) = if reverse {
        (&patch.updated, &patch.original)
    } else {
        (&patch.original, &patch.updated)
    };
    let sql = match patch.table {
        "cursorDiskKV" => "UPDATE cursorDiskKV SET value = ?1 WHERE key = ?2 AND value = ?3",
        "ItemTable" => "UPDATE ItemTable SET value = ?1 WHERE key = ?2 AND value = ?3",
        _ => {
            return Err(AppError::Internal(
                "unsupported Cursor patch table".to_owned(),
            ))
        }
    };
    let changed = transaction.execute(sql, params![replacement, &patch.key, expected])?;
    if changed != 1 {
        return Err(AppError::Conflict(
            "Cursor session metadata changed while it was being renamed".to_owned(),
        ));
    }
    transaction.commit()?;
    Ok(())
}

fn parse_cursor_composer(raw: &[u8], native_session_id: &str) -> AppResult<Value> {
    let value = serde_json::from_slice::<Value>(raw)
        .map_err(|_| AppError::Unsupported("Cursor composerData is not valid JSON".to_owned()))?;
    let Some(object) = value.as_object() else {
        return Err(AppError::Unsupported(
            "Cursor composerData is not a JSON object".to_owned(),
        ));
    };
    if object.get("composerId").and_then(Value::as_str) != Some(native_session_id) {
        return Err(AppError::Conflict(
            "Cursor composerData key does not match composerId".to_owned(),
        ));
    }
    if object
        .get("name")
        .is_some_and(|name| !name.is_string() && !name.is_null())
    {
        return Err(AppError::Unsupported(
            "Cursor composerData name has an unsupported type".to_owned(),
        ));
    }
    Ok(value)
}

fn sql_value_bytes(value: &SqlValue) -> AppResult<&[u8]> {
    match value {
        SqlValue::Text(text) => Ok(text.as_bytes()),
        SqlValue::Blob(bytes) => Ok(bytes),
        _ => Err(AppError::Unsupported(
            "Cursor state value is neither TEXT nor BLOB".to_owned(),
        )),
    }
}

fn json_sql_value_like(original: &SqlValue, value: &Value) -> AppResult<SqlValue> {
    match original {
        SqlValue::Text(_) => serde_json::to_string(value)
            .map(SqlValue::Text)
            .map_err(|error| AppError::Internal(error.to_string())),
        SqlValue::Blob(_) => serde_json::to_vec(value)
            .map(SqlValue::Blob)
            .map_err(|error| AppError::Internal(error.to_string())),
        _ => Err(AppError::Unsupported(
            "Cursor state value is neither TEXT nor BLOB".to_owned(),
        )),
    }
}

fn open_cursor_readonly(path: &Path) -> AppResult<Connection> {
    Ok(Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?)
}

fn sqlite_table_exists(connection: &Connection, table: &str) -> AppResult<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [table],
        |row| row.get::<_, i64>(0),
    )? != 0)
}

fn collect_visible_text(value: &Value, output: &mut Vec<String>) {
    match value {
        Value::String(text) => output.push(text.to_owned()),
        Value::Array(items) => {
            for item in items {
                collect_visible_text(item, output);
            }
        }
        Value::Object(object) => {
            let block_type = object.get("type").and_then(Value::as_str);
            if matches!(
                block_type,
                Some("tool_use" | "tool_result" | "thinking" | "redacted_thinking")
            ) {
                return;
            }
            if let Some(text) = object.get("text").and_then(Value::as_str) {
                output.push(text.to_owned());
            } else if let Some(content) = object.get("content") {
                collect_visible_text(content, output);
            }
        }
        _ => {}
    }
}

fn validate_title(title: &str) -> AppResult<&str> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::InvalidInput(
            "session title cannot be empty".to_owned(),
        ));
    }
    if title.chars().count() > TITLE_CHAR_LIMIT {
        return Err(AppError::InvalidInput(format!(
            "session title cannot exceed {TITLE_CHAR_LIMIT} characters"
        )));
    }
    if title
        .chars()
        .any(|character| character == '\0' || character == '\r' || character == '\n')
    {
        return Err(AppError::InvalidInput(
            "session title cannot contain line breaks or NUL characters".to_owned(),
        ));
    }
    Ok(title)
}

fn is_safe_native_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 200
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn namespaced_id(source: &str, native_id: &str) -> String {
    format!("{source}:{native_id}")
}

fn clean_title(text: &str) -> String {
    let first_line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default()
        .trim_start_matches(|character: char| {
            character.is_whitespace() || matches!(character, '#' | '>' | '-' | '*' | '•')
        });
    truncate_chars(
        &first_line.split_whitespace().collect::<Vec<_>>().join(" "),
        TITLE_CHAR_LIMIT,
    )
}

fn nonempty_title(title: String) -> String {
    if title.trim().is_empty() {
        "Untitled session".to_owned()
    } else {
        title
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

fn string_field<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
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

fn modified_seconds(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| saturating_i64(duration.as_secs()))
        .unwrap_or_default()
}

fn saturating_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn file_uri_to_path(raw: &str) -> Option<String> {
    if raw.starts_with("file:") {
        return url::Url::parse(raw)
            .ok()?
            .to_file_path()
            .ok()
            .map(|path| path_to_string(&path));
    }
    Path::new(raw)
        .is_absolute()
        .then(|| path_to_string(Path::new(raw)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const CLAUDE_ID: &str = "11111111-2222-3333-4444-555555555555";
    const CURSOR_ID: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    #[test]
    fn claude_scan_prefers_custom_title_and_namespaces_id() {
        let temp = TempDir::new().unwrap();
        let project = temp.path().join("D--work-demo");
        fs::create_dir_all(&project).unwrap();
        let transcript = project.join(format!("{CLAUDE_ID}.jsonl"));
        fs::write(
            &transcript,
            format!(
                "{{\"type\":\"user\",\"sessionId\":\"{CLAUDE_ID}\",\"cwd\":\"D:\\\\work\\\\demo\",\"timestamp\":\"2026-07-15T10:00:00Z\",\"message\":{{\"content\":[{{\"type\":\"text\",\"text\":\"first request\"}},{{\"type\":\"tool_result\",\"content\":\"hidden\"}}]}}}}\n{{\"type\":\"assistant\",\"sessionId\":\"{CLAUDE_ID}\",\"timestamp\":\"2026-07-15T10:01:00Z\",\"message\":{{\"content\":\"answer\"}}}}\n{{\"type\":\"ai-title\",\"sessionId\":\"{CLAUDE_ID}\",\"aiTitle\":\"AI title\"}}\n{{\"type\":\"custom-title\",\"sessionId\":\"{CLAUDE_ID}\",\"customTitle\":\"User title\"}}\n"
            ),
        )
        .unwrap();

        let sessions = scan_claude_projects(temp.path()).unwrap();
        assert_eq!(sessions.len(), 1);
        let session = &sessions[0];
        assert_eq!(session.session_id, format!("claude:{CLAUDE_ID}"));
        assert_eq!(session.native_session_id, CLAUDE_ID);
        assert_eq!(session.title, "User title");
        assert_eq!(session.title_origin, "custom");
        assert!(session.can_rename);
        assert!(session.content.contains("first request"));
        assert!(session.content.contains("answer"));
        assert!(!session.content.contains("hidden"));
    }

    #[test]
    fn claude_rename_appends_native_custom_title_record() {
        let temp = TempDir::new().unwrap();
        let transcript = temp.path().join(format!("{CLAUDE_ID}.jsonl"));
        fs::write(
            &transcript,
            format!(
                "{{\"type\":\"user\",\"sessionId\":\"{CLAUDE_ID}\",\"message\":{{\"content\":\"hello\"}}}}"
            ),
        )
        .unwrap();

        rename_claude_session(&transcript, CLAUDE_ID, "Renamed in manager").unwrap();
        let lines = fs::read_to_string(&transcript).unwrap();
        assert!(lines.ends_with('\n'));
        let last = serde_json::from_str::<Value>(lines.lines().last().unwrap()).unwrap();
        assert_eq!(last["type"], "custom-title");
        assert_eq!(last["customTitle"], "Renamed in manager");
        assert_eq!(last["sessionId"], CLAUDE_ID);
        let rescanned = parse_claude_transcript(&transcript).unwrap().unwrap();
        assert_eq!(rescanned.title, "Renamed in manager");
    }

    #[test]
    fn claude_rename_rejects_conflicting_session_id_without_writing() {
        let temp = TempDir::new().unwrap();
        let transcript = temp.path().join(format!("{CLAUDE_ID}.jsonl"));
        let original =
            "{\"type\":\"user\",\"sessionId\":\"different\",\"message\":{\"content\":\"hello\"}}\n";
        fs::write(&transcript, original).unwrap();
        assert!(rename_claude_session(&transcript, CLAUDE_ID, "Nope").is_err());
        assert_eq!(fs::read_to_string(&transcript).unwrap(), original);
    }

    fn create_cursor_fixture(root: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let user = root.join("User");
        let global = user.join("globalStorage").join("state.vscdb");
        let workspace = user
            .join("workspaceStorage")
            .join("fixture")
            .join("state.vscdb");
        fs::create_dir_all(global.parent().unwrap()).unwrap();
        fs::create_dir_all(workspace.parent().unwrap()).unwrap();
        let connection = Connection::open(&global).unwrap();
        connection
            .execute(
                "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
                [],
            )
            .unwrap();
        let composer = json!({
            "composerId": CURSOR_ID,
            "name": "",
            "createdAt": 1_700_000_000_000_i64,
            "lastUpdatedAt": 1_700_000_100_000_i64,
            "context": {},
        });
        connection
            .execute(
                "INSERT INTO cursorDiskKV(key,value) VALUES(?1,?2)",
                params![format!("composerData:{CURSOR_ID}"), composer.to_string()],
            )
            .unwrap();
        let user_bubble = json!({
            "bubbleId": "bubble-user",
            "type": 1,
            "text": "Cursor request",
            "createdAt": "2026-07-15T10:00:00Z",
            "workspaceUris": ["file:///D:/work/demo"],
        });
        let assistant_bubble = json!({
            "bubbleId": "bubble-ai",
            "type": 2,
            "text": "Cursor answer",
            "createdAt": "2026-07-15T10:01:00Z",
        });
        for (id, bubble) in [
            ("bubble-user", user_bubble),
            ("bubble-ai", assistant_bubble),
        ] {
            connection
                .execute(
                    "INSERT INTO cursorDiskKV(key,value) VALUES(?1,?2)",
                    params![format!("bubbleId:{CURSOR_ID}:{id}"), bubble.to_string()],
                )
                .unwrap();
        }
        drop(connection);

        let connection = Connection::open(&workspace).unwrap();
        connection
            .execute(
                "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
                [],
            )
            .unwrap();
        let list = json!({"allComposers":[{"composerId":CURSOR_ID,"name":""}]});
        connection
            .execute(
                "INSERT INTO ItemTable(key,value) VALUES('composer.composerData',?1)",
                [list.to_string()],
            )
            .unwrap();
        drop(connection);
        (global, workspace, root.join("projects"))
    }

    #[test]
    fn cursor_scan_uses_composer_and_bubble_metadata() {
        let temp = TempDir::new().unwrap();
        let (global, _workspace, projects) = create_cursor_fixture(temp.path());
        let sessions = scan_cursor_storage(&global, &projects).unwrap();
        assert_eq!(sessions.len(), 1);
        let session = &sessions[0];
        assert_eq!(session.session_id, format!("cursor:{CURSOR_ID}"));
        assert_eq!(session.title, "Cursor request");
        assert_eq!(session.title_origin, "derived");
        assert_eq!(session.source_kind, "cursor");
        assert!(session.can_rename);
        assert!(session.content.contains("Cursor request"));
        assert!(session.content.contains("Cursor answer"));
        assert!(session.cwd.as_deref().unwrap().contains("D:"));
    }

    #[test]
    fn cursor_rename_updates_global_and_workspace_names() {
        let temp = TempDir::new().unwrap();
        let (global, workspace, _projects) = create_cursor_fixture(temp.path());
        rename_cursor_session(&global, CURSOR_ID, "Native Cursor title").unwrap();

        let global_connection = Connection::open(&global).unwrap();
        let raw = global_connection
            .query_row(
                "SELECT value FROM cursorDiskKV WHERE key=?1",
                [format!("composerData:{CURSOR_ID}")],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["name"], "Native Cursor title");
        assert_eq!(
            global_connection
                .query_row(
                    "SELECT typeof(value) FROM cursorDiskKV WHERE key=?1",
                    [format!("composerData:{CURSOR_ID}")],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "text"
        );

        let workspace_connection = Connection::open(&workspace).unwrap();
        let raw = workspace_connection
            .query_row(
                "SELECT value FROM ItemTable WHERE key='composer.composerData'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["allComposers"][0]["name"], "Native Cursor title");
    }

    #[test]
    fn cursor_rename_rejects_mismatched_composer_id() {
        let temp = TempDir::new().unwrap();
        let (global, _workspace, _projects) = create_cursor_fixture(temp.path());
        let connection = Connection::open(&global).unwrap();
        connection
            .execute(
                "UPDATE cursorDiskKV SET value=?1 WHERE key=?2",
                params![
                    json!({"composerId":"different","name":"old"}).to_string(),
                    format!("composerData:{CURSOR_ID}")
                ],
            )
            .unwrap();
        drop(connection);
        assert!(rename_cursor_session(&global, CURSOR_ID, "Nope").is_err());
        let connection = Connection::open(&global).unwrap();
        let raw = connection
            .query_row(
                "SELECT value FROM cursorDiskKV WHERE key=?1",
                [format!("composerData:{CURSOR_ID}")],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["name"], "old");
    }
}
