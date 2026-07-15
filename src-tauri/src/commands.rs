use std::{path::Path, process::Command};

use chrono::Utc;
use rusqlite::OptionalExtension;
use tauri::State;
use uuid::Uuid;

use crate::{
    custom_skills,
    error::{AppError, AppResult},
    managed,
    models::{
        AiDescriptionSettings, AnswerCustomSkillQuestionRequest, AuditLogEntry, CapabilityInfo,
        ClearSkillDescriptionRequest, CustomSkillRun, CustomSkillsSettings,
        GenerateCustomSkillRequest, GenerateSkillDescriptionRequest, ImportSkillRequest,
        ImportSkillResult, LocalAiProvider, OpenApiSearchProfile, Project, ProviderTestResult,
        RenameSessionRequest, RepairCustomSkillsRequest, RepairCustomSkillsResult,
        SaveCustomSkillRequest, SaveCustomSkillResult, SaveOpenApiSearchProfileRequest,
        SessionDetail, SessionSearchRequest, SessionSummary, SetManualSkillDescriptionRequest,
        SkillDescriptionJob, SkillDescriptionLocalization, SkillDetail, SkillScanRequest,
        SkillSummary, StartCustomSkillRunRequest, StartSkillDescriptionJobRequest,
        UpdateAiDescriptionSettingsRequest, UpdateCustomSkillsSettingsRequest,
        WriteSkillFileRequest, WriteSkillFileResult,
    },
    security, sessions, skill_descriptions, skills, AppState,
};

async fn run_blocking<T>(operation: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T>
where
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| AppError::Internal(format!("background task failed: {error}")))?
}

fn append_audit(
    database: &crate::db::Database,
    action_type: &str,
    target_id: Option<&str>,
    detail: serde_json::Value,
) -> AppResult<()> {
    database.with_connection(|connection| {
        connection.execute(
            "INSERT INTO audit_logs(action_type, target_id, result, detail_json, created_at)
             VALUES (?1, ?2, 'success', ?3, ?4)",
            rusqlite::params![
                action_type,
                target_id,
                detail.to_string(),
                Utc::now().timestamp()
            ],
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn get_capabilities() -> CapabilityInfo {
    let codex_cli_available = Command::new("codex")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false);
    CapabilityInfo {
        platform: std::env::consts::OS.to_owned(),
        codex_cli_available,
        // The first release intentionally uses the filesystem compatibility
        // layer. Do not report a CLI process check as an App Server session.
        app_server_available: false,
        session_source: "filesystem-fallback".to_owned(),
        symlink_supported: cfg!(any(target_os = "macos", target_os = "linux")),
        junction_supported: cfg!(target_os = "windows"),
        no_telemetry: true,
    }
}

#[tauri::command]
pub fn list_projects(state: State<'_, AppState>) -> AppResult<Vec<Project>> {
    state.database.with_connection(|connection| {
        let mut statement = connection.prepare(
            "SELECT id, name, root_path, trusted, created_at, updated_at FROM projects ORDER BY updated_at DESC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                root_path: row.get(2)?,
                trusted: row.get::<_, i64>(3)? != 0,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })
}

#[tauri::command]
pub fn add_project(path: String, trusted: bool, state: State<'_, AppState>) -> AppResult<Project> {
    let root = std::fs::canonicalize(Path::new(&path))?;
    if !root.is_dir() {
        return Err(AppError::InvalidInput(
            "project path must be a directory".to_owned(),
        ));
    }
    let root_path = root.to_string_lossy().into_owned();
    let name = root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Project")
        .to_owned();
    let now = Utc::now().timestamp();
    state.database.with_connection(|connection| {
        let existing = connection
            .query_row(
                "SELECT id, created_at FROM projects WHERE root_path = ?1",
                [&root_path],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?;
        let (id, created_at) = existing.unwrap_or_else(|| (Uuid::new_v4().to_string(), now));
        connection.execute(
            "INSERT INTO projects(id, name, root_path, trusted, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)\n\
             ON CONFLICT(root_path) DO UPDATE SET name=excluded.name, trusted=excluded.trusted, updated_at=excluded.updated_at",
            rusqlite::params![id, name, root_path, trusted as i64, created_at, now],
        )?;
        connection.execute(
            "INSERT INTO audit_logs(action_type, target_id, result, detail_json, created_at)
             VALUES ('PROJECT_UPSERT', ?1, 'success', ?2, ?3)",
            rusqlite::params![id, serde_json::json!({"trusted": trusted}).to_string(), now],
        )?;
        Ok(Project {
            id,
            name,
            root_path,
            trusted,
            created_at,
            updated_at: now,
        })
    })
}

#[tauri::command]
pub fn remove_project(id: String, state: State<'_, AppState>) -> AppResult<()> {
    state.database.with_connection(|connection| {
        connection.execute("DELETE FROM projects WHERE id = ?1", [&id])?;
        connection.execute(
            "INSERT INTO audit_logs(action_type, target_id, result, detail_json, created_at)
             VALUES ('PROJECT_REMOVE', ?1, 'success', '{}', ?2)",
            rusqlite::params![id, Utc::now().timestamp()],
        )?;
        Ok(())
    })
}

#[tauri::command]
pub async fn index_sessions(state: State<'_, AppState>) -> AppResult<usize> {
    let database = state.database.clone();
    run_blocking(move || {
        let changed = sessions::index_local_sessions(&database)?;
        append_audit(
            &database,
            "SESSION_INDEX",
            None,
            serde_json::json!({"changed": changed}),
        )?;
        Ok(changed)
    })
    .await
}

#[tauri::command]
pub async fn rename_session(
    request: RenameSessionRequest,
    state: State<'_, AppState>,
) -> AppResult<SessionSummary> {
    let database = state.database.clone();
    run_blocking(move || {
        let summary = sessions::rename_session(&database, &request.id, &request.title)?;
        append_audit(
            &database,
            "SESSION_RENAME",
            Some(&request.id),
            serde_json::json!({"agent": summary.agent_type, "titleLength": request.title.chars().count()}),
        )?;
        Ok(summary)
    })
    .await
}

#[tauri::command]
pub fn search_sessions(
    request: SessionSearchRequest,
    state: State<'_, AppState>,
) -> AppResult<Vec<SessionSummary>> {
    sessions::search_sessions(&state.database, &request)
}

#[tauri::command]
pub fn get_session(id: String, state: State<'_, AppState>) -> AppResult<SessionDetail> {
    sessions::get_session(&state.database, &id)
}

#[tauri::command]
pub async fn scan_skills(
    request: SkillScanRequest,
    state: State<'_, AppState>,
) -> AppResult<Vec<SkillSummary>> {
    let database = state.database.clone();
    run_blocking(move || {
        let summaries = skills::scan_skills(&database, &request)?;
        append_audit(
            &database,
            "SKILL_SCAN",
            None,
            serde_json::json!({"count": summaries.len()}),
        )?;
        Ok(summaries)
    })
    .await
}

#[tauri::command]
pub async fn scan_skill_security(
    location_id: String,
    state: State<'_, AppState>,
) -> AppResult<security::SecurityScanResult> {
    let database = state.database.clone();
    run_blocking(move || {
        let result = security::scan_skill_security(&database, &location_id)?;
        append_audit(
            &database,
            "SKILL_SECURITY_SCAN",
            Some(&location_id),
            serde_json::json!({
                "status": result.status.clone(),
                "findings": result.findings.len(),
                "scannedFiles": result.scanned_files,
            }),
        )?;
        Ok(result)
    })
    .await
}

#[tauri::command]
pub async fn get_skill_security_scan(
    location_id: String,
    state: State<'_, AppState>,
) -> AppResult<Option<security::SecurityScanResult>> {
    let database = state.database.clone();
    run_blocking(move || security::get_skill_security_scan(&database, &location_id)).await
}

#[tauri::command]
pub fn list_audit_logs(
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> AppResult<Vec<AuditLogEntry>> {
    let limit = limit.unwrap_or(100).clamp(1, 500);
    state.database.with_connection(|connection| {
        let mut statement = connection.prepare(
            "SELECT id, action_type, target_id, result, detail_json, created_at
             FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT ?1",
        )?;
        let rows = statement.query_map([i64::from(limit)], |row| {
            let detail_json = row.get::<_, String>(4)?;
            Ok(AuditLogEntry {
                id: row.get(0)?,
                action_type: row.get(1)?,
                target_id: row.get(2)?,
                result: row.get(3)?,
                detail: serde_json::from_str(&detail_json)
                    .unwrap_or_else(|_| serde_json::json!({})),
                created_at: row.get(5)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })
}

#[tauri::command]
pub async fn get_skill(id: String, state: State<'_, AppState>) -> AppResult<SkillDetail> {
    let database = state.database.clone();
    run_blocking(move || skills::get_skill(&database, &id)).await
}

#[tauri::command]
pub async fn read_skill_file(
    id: String,
    relative_path: String,
    state: State<'_, AppState>,
) -> AppResult<String> {
    let database = state.database.clone();
    run_blocking(move || skills::read_skill_file(&database, &id, &relative_path)).await
}

#[tauri::command]
pub async fn import_skill(
    request: ImportSkillRequest,
    state: State<'_, AppState>,
) -> AppResult<ImportSkillResult> {
    let database = state.database.clone();
    let app_data_dir = state.app_data_dir.clone();
    run_blocking(move || managed::import_skill(&database, &app_data_dir, &request)).await
}

#[tauri::command]
pub fn set_skill_enabled(
    location_id: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> AppResult<()> {
    managed::set_skill_enabled(&state.database, &location_id, enabled)
}

#[tauri::command]
pub async fn remove_managed_binding(
    location_id: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let database = state.database.clone();
    run_blocking(move || managed::remove_managed_binding(&database, &location_id)).await
}

#[tauri::command]
pub async fn write_skill_file(
    request: WriteSkillFileRequest,
    state: State<'_, AppState>,
) -> AppResult<WriteSkillFileResult> {
    let database = state.database.clone();
    run_blocking(move || managed::write_skill_file(&database, &request)).await
}

#[tauri::command]
pub fn get_ai_description_settings(state: State<'_, AppState>) -> AppResult<AiDescriptionSettings> {
    skill_descriptions::get_settings(&state.database)
}

#[tauri::command]
pub fn update_ai_description_settings(
    request: UpdateAiDescriptionSettingsRequest,
    state: State<'_, AppState>,
) -> AppResult<AiDescriptionSettings> {
    let settings = skill_descriptions::update_settings(&state.database, &request)?;
    if !settings.enabled {
        state.ai_descriptions.cancel_active_jobs();
    }
    Ok(settings)
}

#[tauri::command]
pub fn set_ai_provider_secret(
    provider: Option<String>,
    secret: String,
    state: State<'_, AppState>,
) -> AppResult<AiDescriptionSettings> {
    match provider.as_deref().unwrap_or("openai") {
        "openai" => skill_descriptions::set_openai_secret(&secret)?,
        "compatible" => skill_descriptions::set_compatible_secret(&secret)?,
        _ => {
            return Err(AppError::InvalidInput(
                "provider secret is only supported for openai or compatible".to_owned(),
            ));
        }
    }
    skill_descriptions::get_settings(&state.database)
}

#[tauri::command]
pub fn delete_ai_provider_secret(
    provider: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<AiDescriptionSettings> {
    match provider.as_deref().unwrap_or("openai") {
        "openai" => skill_descriptions::delete_openai_secret()?,
        "compatible" => skill_descriptions::delete_compatible_secret()?,
        _ => {
            return Err(AppError::InvalidInput(
                "provider secret is only supported for openai or compatible".to_owned(),
            ));
        }
    }
    skill_descriptions::get_settings(&state.database)
}

#[tauri::command]
pub async fn detect_local_ai_providers(
    state: State<'_, AppState>,
) -> AppResult<Vec<LocalAiProvider>> {
    let settings = skill_descriptions::get_settings(&state.database)?;
    if !settings.enabled {
        return Err(crate::error::AppError::AiNotConfigured(
            "enable AI Chinese descriptions before detecting local services".to_owned(),
        ));
    }
    Ok(state.ai_descriptions.detect_local_providers().await)
}

#[tauri::command]
pub async fn test_ai_description_provider(
    state: State<'_, AppState>,
) -> AppResult<ProviderTestResult> {
    state.ai_descriptions.test_provider(&state.database).await
}

#[tauri::command]
pub async fn generate_skill_description(
    request: GenerateSkillDescriptionRequest,
    state: State<'_, AppState>,
) -> AppResult<SkillDescriptionLocalization> {
    state
        .ai_descriptions
        .generate(&state.database, &request)
        .await
}

#[tauri::command]
pub fn set_manual_skill_description(
    request: SetManualSkillDescriptionRequest,
    state: State<'_, AppState>,
) -> AppResult<SkillDescriptionLocalization> {
    skill_descriptions::set_manual_description(&state.database, &request)
}

#[tauri::command]
pub fn clear_skill_description(
    request: ClearSkillDescriptionRequest,
    state: State<'_, AppState>,
) -> AppResult<()> {
    skill_descriptions::clear_description(&state.database, &request)
}

#[tauri::command]
pub fn start_skill_description_job(
    request: StartSkillDescriptionJobRequest,
    state: State<'_, AppState>,
) -> AppResult<SkillDescriptionJob> {
    state
        .ai_descriptions
        .start_job(state.database.clone(), request)
}

#[tauri::command]
pub fn get_skill_description_job(
    job_id: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<Option<SkillDescriptionJob>> {
    state.ai_descriptions.get_job(job_id.as_deref())
}

#[tauri::command]
pub fn cancel_skill_description_job(
    job_id: String,
    state: State<'_, AppState>,
) -> AppResult<SkillDescriptionJob> {
    state.ai_descriptions.cancel_job(&job_id)
}

#[tauri::command]
pub fn get_custom_skills_settings(state: State<'_, AppState>) -> AppResult<CustomSkillsSettings> {
    custom_skills::get_settings(&state.database)
}

#[tauri::command]
pub fn update_custom_skills_settings(
    request: UpdateCustomSkillsSettingsRequest,
    state: State<'_, AppState>,
) -> AppResult<CustomSkillsSettings> {
    custom_skills::update_settings(&state.database, &request)
}

#[tauri::command]
pub fn list_openapi_search_profiles(
    state: State<'_, AppState>,
) -> AppResult<Vec<OpenApiSearchProfile>> {
    custom_skills::list_search_profiles(&state.database)
}

#[tauri::command]
pub fn save_openapi_search_profile(
    request: SaveOpenApiSearchProfileRequest,
    state: State<'_, AppState>,
) -> AppResult<OpenApiSearchProfile> {
    custom_skills::save_search_profile(&state.database, &request)
}

#[tauri::command]
pub async fn start_custom_skill_run(
    request: StartCustomSkillRunRequest,
    state: State<'_, AppState>,
) -> AppResult<CustomSkillRun> {
    custom_skills::start_run(&state.database, &request).await
}

#[tauri::command]
pub fn answer_custom_skill_question(
    request: AnswerCustomSkillQuestionRequest,
    state: State<'_, AppState>,
) -> AppResult<CustomSkillRun> {
    custom_skills::answer_question(&state.database, &request)
}

#[tauri::command]
pub async fn generate_custom_skill(
    request: GenerateCustomSkillRequest,
    state: State<'_, AppState>,
) -> AppResult<CustomSkillRun> {
    custom_skills::generate_run(&state.database, &state.ai_descriptions, &request).await
}

#[tauri::command]
pub async fn validate_custom_skill_run(
    run_id: String,
    state: State<'_, AppState>,
) -> AppResult<CustomSkillRun> {
    custom_skills::validate_run(&state.database, &state.ai_descriptions, &run_id).await
}

#[tauri::command]
pub async fn save_custom_skill(
    request: SaveCustomSkillRequest,
    state: State<'_, AppState>,
) -> AppResult<SaveCustomSkillResult> {
    let database = state.database.clone();
    run_blocking(move || custom_skills::save_run(&database, &request)).await
}

#[tauri::command]
pub fn get_custom_skill_run(id: String, state: State<'_, AppState>) -> AppResult<CustomSkillRun> {
    custom_skills::get_run(&state.database, &id)
}

#[tauri::command]
pub async fn repair_custom_skills(
    request: RepairCustomSkillsRequest,
    state: State<'_, AppState>,
) -> AppResult<RepairCustomSkillsResult> {
    let database = state.database.clone();
    run_blocking(move || custom_skills::repair(&database, &request)).await
}
