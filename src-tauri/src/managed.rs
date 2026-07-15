use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};
use toml_edit::{value, ArrayOfTables, DocumentMut, Item, Table};
use uuid::Uuid;
use walkdir::WalkDir;

use crate::{
    db::Database,
    error::{AppError, AppResult},
    models::{
        DeploymentTarget, ImportSkillRequest, ImportSkillResult, SkillBindingSummary,
        WriteSkillFileRequest, WriteSkillFileResult,
    },
    skills,
};

const MAX_IMPORT_BYTES: u64 = 100 * 1024 * 1024;
const MAX_IMPORT_FILES: usize = 10_000;

#[derive(Debug)]
struct ParsedSkill {
    name: String,
    description: String,
}

pub fn import_skill(
    database: &Database,
    app_data_dir: &Path,
    request: &ImportSkillRequest,
) -> AppResult<ImportSkillResult> {
    if request.targets.is_empty() {
        return Err(AppError::InvalidInput(
            "at least one deployment target is required".to_owned(),
        ));
    }

    let requested_source = Path::new(&request.source_path);
    let requested_metadata = metadata_without_links(requested_source, "skill source")?;
    if !requested_metadata.is_dir() {
        return Err(AppError::InvalidInput(
            "skill source must be a directory".to_owned(),
        ));
    }
    let source = fs::canonicalize(requested_source)?;
    let source_metadata = metadata_without_links(&source, "skill source")?;
    if !source_metadata.is_dir() {
        return Err(AppError::InvalidInput(
            "skill source must be a directory".to_owned(),
        ));
    }
    let skill_file = source.join("SKILL.md");
    let skill_metadata = match metadata_without_links(&skill_file, "skill manifest") {
        Ok(metadata) => metadata,
        Err(AppError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(AppError::InvalidInput(
                "skill source must contain SKILL.md".to_owned(),
            ));
        }
        Err(error) => return Err(error),
    };
    if !skill_metadata.is_file() {
        return Err(AppError::InvalidInput(
            "skill source must contain SKILL.md".to_owned(),
        ));
    }

    let parsed = parse_skill(&skill_file)?;
    let deployment_name = safe_slug(&parsed.name);
    if deployment_name.is_empty() {
        return Err(AppError::InvalidInput(
            "skill name must contain an ASCII letter, number, '-' or '_'".to_owned(),
        ));
    }
    let (tree_hash, files) = hash_tree(&source)?;
    let store = app_data_dir.join("skills-store");
    let object_path = store.join("objects").join(&tree_hash);
    fs::create_dir_all(store.join("objects"))?;

    if !object_path.exists() {
        let staging = store
            .join("staging")
            .join(format!("{}-{}", Uuid::new_v4(), tree_hash));
        fs::create_dir_all(&staging)?;
        if let Err(error) = copy_tree(&source, &staging, &files) {
            let _ = remove_tree(&staging);
            return Err(error);
        }
        let (staged_hash, _) = hash_tree(&staging)?;
        if staged_hash != tree_hash {
            let _ = remove_tree(&staging);
            return Err(AppError::Conflict(
                "skill source changed while it was being imported; retry the import".to_owned(),
            ));
        }
        if object_path.exists() {
            remove_tree(&staging)?;
        } else {
            match fs::rename(&staging, &object_path) {
                Ok(()) => {}
                Err(error) if object_path.exists() => {
                    remove_tree(&staging)?;
                    let _ = error;
                }
                Err(error) => return Err(error.into()),
            }
        }
    }
    let (stored_hash, _) = hash_tree(&object_path)?;
    if stored_hash != tree_hash {
        return Err(AppError::Conflict(format!(
            "managed object failed integrity verification: {}",
            object_path.display()
        )));
    }
    make_tree_read_only(&object_path)?;

    let skill_id = Uuid::new_v4().to_string();
    let revision_id = Uuid::new_v4().to_string();
    let operation_id = Uuid::new_v4().to_string();
    let now = Utc::now().timestamp();
    let mut created_bindings = Vec::new();

    let mut planned_bindings = Vec::new();
    let mut planned_paths = HashSet::new();
    for target in &request.targets {
        let root = resolve_target_root(database, target)?;
        let link_path = root.join(&deployment_name);
        let key = link_path.to_string_lossy().to_lowercase();
        if !planned_paths.insert(key) {
            return Err(AppError::InvalidInput(format!(
                "duplicate deployment target: {}",
                link_path.display()
            )));
        }
        if link_path.exists() || fs::symlink_metadata(&link_path).is_ok() {
            return Err(AppError::Conflict(format!(
                "deployment target already exists: {}",
                link_path.display()
            )));
        }
        planned_bindings.push((target.clone(), root, link_path));
    }
    database.with_connection(|connection| {
        connection.execute(
            "INSERT INTO operations(id, operation_type, target_id, state, current_step, request_json, started_at)
             VALUES (?1, 'SKILL_IMPORT', ?2, 'running', 'deploying', ?3, ?4)",
            params![
                operation_id,
                skill_id,
                serde_json::json!({
                    "sourcePath": source,
                    "treeHash": tree_hash,
                    "linkPaths": planned_bindings
                        .iter()
                        .map(|(_, _, path)| path.to_string_lossy().into_owned())
                        .collect::<Vec<_>>(),
                })
                .to_string(),
                now
            ],
        )?;
        Ok(())
    })?;

    let deployment_result = (|| -> AppResult<()> {
        for (target, root, link_path) in &planned_bindings {
            fs::create_dir_all(root)?;
            let link_mode =
                create_directory_binding(&object_path, link_path, request.allow_copy_fallback)?;
            created_bindings.push((target.clone(), link_path.clone(), link_mode));
        }
        Ok(())
    })();
    if let Err(error) = deployment_result {
        rollback_bindings(&created_bindings);
        let _ = finish_operation_failed(database, &operation_id, &error);
        return Err(error);
    }

    let result = database.with_connection(|connection| {
        let transaction = connection.unchecked_transaction()?;
        transaction.execute(
            "INSERT INTO skills(id, logical_name, display_name, description, source_kind, source_uri, managed, active_revision_id, created_at, updated_at)\n\
             VALUES (?1, ?2, ?2, ?3, 'local-import', ?4, 1, ?5, ?6, ?6)",
            params![skill_id, parsed.name, parsed.description, source.to_string_lossy(), revision_id, now],
        )?;
        transaction.execute(
            "INSERT INTO skill_revisions(id, skill_id, tree_hash, object_path, manifest_json, scan_status, created_at)\n\
             VALUES (?1, ?2, ?3, ?4, ?5, 'review', ?6)",
            params![
                revision_id,
                skill_id,
                tree_hash,
                object_path.to_string_lossy(),
                serde_json::json!({"name": parsed.name, "description": parsed.description}).to_string(),
                now
            ],
        )?;

        let mut summaries = Vec::new();
        for (target, link_path, link_mode) in &created_bindings {
            let binding_id = Uuid::new_v4().to_string();
            let target_root = link_path.parent().unwrap_or(link_path);
            transaction.execute(
                "INSERT INTO skill_bindings(id, skill_id, revision_id, agent_type, scope_kind, target_root, link_path, link_mode, health_status, created_at, updated_at)\n\
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'ok', ?9, ?9)",
                params![
                    binding_id,
                    skill_id,
                    revision_id,
                    target.agent_type,
                    target.scope_kind,
                    target_root.to_string_lossy(),
                    link_path.to_string_lossy(),
                    link_mode,
                    now
                ],
            )?;
            summaries.push(SkillBindingSummary {
                id: binding_id,
                agent_type: target.agent_type.clone(),
                scope_kind: target.scope_kind.clone(),
                link_path: link_path.to_string_lossy().into_owned(),
                link_mode: link_mode.clone(),
                health_status: "ok".to_owned(),
            });
        }
        transaction.execute(
            "INSERT INTO audit_logs(action_type, target_id, result, detail_json, created_at) VALUES ('SKILL_IMPORT', ?1, 'success', ?2, ?3)",
            params![skill_id, serde_json::json!({"treeHash": tree_hash, "targets": summaries.len()}).to_string(), now],
        )?;
        transaction.execute(
            "UPDATE operations SET state = 'completed', current_step = 'done', finished_at = ?1 WHERE id = ?2",
            params![Utc::now().timestamp(), operation_id],
        )?;
        transaction.commit()?;
        Ok(ImportSkillResult {
            skill_id: skill_id.clone(),
            revision_id: revision_id.clone(),
            name: parsed.name.clone(),
            tree_hash: tree_hash.clone(),
            bindings: summaries,
        })
    });

    if result.is_err() {
        rollback_bindings(&created_bindings);
        if let Err(error) = &result {
            let _ = finish_operation_failed(database, &operation_id, error);
        }
    }
    result
}

#[derive(Debug)]
struct ManagedBindingRemoval {
    location_id: String,
    skill_id: String,
    skill_path: PathBuf,
    scope_kind: String,
    project_id: Option<String>,
    project_trusted: bool,
    binding_id: String,
    revision_id: String,
    link_path: PathBuf,
    link_mode: String,
    object_path: PathBuf,
    tree_hash: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeploymentPresence {
    Present,
    Missing,
}

pub fn remove_managed_binding(database: &Database, location_id: &str) -> AppResult<()> {
    let removal = load_managed_binding_removal(database, location_id)?;
    let operation_id = Uuid::new_v4().to_string();
    let now = Utc::now().timestamp();
    database.with_connection(|connection| {
        connection.execute(
            "INSERT INTO operations(
                id, operation_type, target_id, state, current_step, request_json, started_at
             ) VALUES (?1, 'SKILL_UNINSTALL', ?2, 'running', 'validating', ?3, ?4)",
            params![
                operation_id,
                removal.location_id,
                serde_json::json!({
                    "locationId": removal.location_id,
                    "bindingId": removal.binding_id,
                    "revisionId": removal.revision_id,
                    "linkPath": removal.link_path,
                    "linkMode": removal.link_mode,
                })
                .to_string(),
                now
            ],
        )?;
        Ok(())
    })?;

    let result = (|| -> AppResult<()> {
        let project_scoped = matches!(removal.scope_kind.as_str(), "project" | "repo");
        if project_scoped && (removal.project_id.is_none() || !removal.project_trusted) {
            return Err(AppError::Unsupported(
                "project must be trusted before removing its managed skills".to_owned(),
            ));
        }
        if !project_scoped && removal.project_id.is_some() {
            return Err(AppError::Conflict(
                "managed location has inconsistent project scope metadata".to_owned(),
            ));
        }
        if !removal.link_path.is_absolute() || !removal.object_path.is_absolute() {
            return Err(AppError::Conflict(
                "managed binding contains a non-absolute deployment or object path".to_owned(),
            ));
        }

        let mut presence = validate_managed_deployment(&removal)?;
        database.with_connection(|connection| {
            connection.execute(
                "UPDATE operations SET current_step = 'removing_binding' WHERE id = ?1",
                [&operation_id],
            )?;
            Ok(())
        })?;
        if presence == DeploymentPresence::Present {
            presence = remove_validated_deployment(&removal)?;
        }

        database.with_connection(|connection| {
            let transaction = connection.unchecked_transaction()?;
            let removed_location = transaction.execute(
                "DELETE FROM skill_locations WHERE id = ?1 AND skill_id = ?2",
                params![removal.location_id, removal.skill_id],
            )?;
            if removed_location != 1 {
                return Err(AppError::Conflict(
                    "managed skill location changed during uninstall".to_owned(),
                ));
            }
            let removed_binding = transaction.execute(
                "DELETE FROM skill_bindings
                 WHERE id = ?1 AND skill_id = ?2 AND revision_id = ?3 AND link_path = ?4",
                params![
                    removal.binding_id,
                    removal.skill_id,
                    removal.revision_id,
                    removal.link_path.to_string_lossy()
                ],
            )?;
            if removed_binding != 1 {
                return Err(AppError::Conflict(
                    "managed skill binding changed during uninstall".to_owned(),
                ));
            }
            transaction.execute(
                "INSERT INTO audit_logs(action_type, target_id, result, detail_json, created_at)
                 VALUES ('SKILL_UNINSTALL', ?1, 'success', ?2, ?3)",
                params![
                    removal.location_id,
                    serde_json::json!({
                        "bindingId": removal.binding_id,
                        "revisionId": removal.revision_id,
                        "linkPath": removal.link_path,
                        "linkMode": removal.link_mode,
                        "targetAlreadyMissing": presence == DeploymentPresence::Missing,
                    })
                    .to_string(),
                    Utc::now().timestamp()
                ],
            )?;
            transaction.execute(
                "UPDATE operations
                 SET state = 'completed', current_step = 'done', finished_at = ?1
                 WHERE id = ?2",
                params![Utc::now().timestamp(), operation_id],
            )?;
            transaction.commit()?;
            Ok(())
        })
    })();

    if let Err(error) = &result {
        let _ =
            finish_uninstall_operation_failed(database, &operation_id, &removal.location_id, error);
    }
    result
}

fn load_managed_binding_removal(
    database: &Database,
    location_id: &str,
) -> AppResult<ManagedBindingRemoval> {
    let (skill_id, skill_path, agent_type, scope_kind, project_id, project_trusted, managed) =
        database.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT l.skill_id, l.skill_path, l.agent_type, l.scope_kind, l.project_id,
                            CASE
                                WHEN l.project_id IS NULL THEN 1
                                ELSE COALESCE(p.trusted, 0)
                            END,
                            COALESCE(s.managed, 0)
                     FROM skill_locations l
                     LEFT JOIN skills s ON s.id = l.skill_id
                     LEFT JOIN projects p ON p.id = l.project_id
                     WHERE l.id = ?1",
                    [location_id],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, Option<String>>(4)?,
                            row.get::<_, i64>(5)? != 0,
                            row.get::<_, i64>(6)? == 1,
                        ))
                    },
                )
                .optional()?
                .ok_or_else(|| {
                    AppError::NotFound(format!("skill location not found: {location_id}"))
                })
        })?;
    let skill_id = match (skill_id, managed) {
        (Some(skill_id), true) => skill_id,
        _ => {
            return Err(AppError::Unsupported(
                "only Skills Manager managed skill bindings can be removed".to_owned(),
            ))
        }
    };

    let candidates = database.with_connection(|connection| {
        let mut statement = connection.prepare(
            "SELECT b.id, b.revision_id, b.agent_type, b.scope_kind, b.link_path, b.link_mode,
                    r.object_path, r.tree_hash
             FROM skill_bindings b
             JOIN skill_revisions r ON r.id = b.revision_id AND r.skill_id = b.skill_id
             WHERE b.skill_id = ?1
             ORDER BY b.id",
        )?;
        let rows = statement
            .query_map([&skill_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;
    let mut matching = candidates
        .into_iter()
        .filter(|candidate| binding_paths_equal(Path::new(&skill_path), Path::new(&candidate.4)));
    let candidate = matching.next().ok_or_else(|| {
        AppError::Conflict(
            "managed location does not exactly match any recorded deployment binding".to_owned(),
        )
    })?;
    if matching.next().is_some() {
        return Err(AppError::Conflict(
            "managed location ambiguously matches multiple deployment bindings".to_owned(),
        ));
    }
    if candidate.2 != agent_type || !binding_scopes_equal(&candidate.3, &scope_kind) {
        return Err(AppError::Conflict(
            "managed location metadata does not match its deployment binding".to_owned(),
        ));
    }

    Ok(ManagedBindingRemoval {
        location_id: location_id.to_owned(),
        skill_id,
        skill_path: PathBuf::from(skill_path),
        scope_kind,
        project_id,
        project_trusted,
        binding_id: candidate.0,
        revision_id: candidate.1,
        link_path: PathBuf::from(candidate.4),
        link_mode: candidate.5,
        object_path: PathBuf::from(candidate.6),
        tree_hash: candidate.7,
    })
}

fn validate_managed_deployment(removal: &ManagedBindingRemoval) -> AppResult<DeploymentPresence> {
    debug_assert!(binding_paths_equal(&removal.skill_path, &removal.link_path));
    let metadata = match fs::symlink_metadata(&removal.link_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DeploymentPresence::Missing)
        }
        Err(error) => return Err(error.into()),
    };

    match removal.link_mode.as_str() {
        "copy" => {
            if metadata_is_link_like(&metadata) || !metadata.is_dir() {
                return Err(AppError::Conflict(format!(
                    "managed copy was replaced with a different filesystem object: {}",
                    removal.link_path.display()
                )));
            }
            let deployed_hash = hash_tree(&removal.link_path).map_err(|error| {
                AppError::Conflict(format!(
                    "managed copy cannot be verified and was not removed: {error}"
                ))
            })?;
            if deployed_hash.0 != removal.tree_hash {
                return Err(AppError::Conflict(format!(
                    "managed copy was modified and was not removed: {}",
                    removal.link_path.display()
                )));
            }
        }
        "junction" | "symlink" => {
            if !metadata_is_link_like(&metadata) {
                return Err(AppError::Conflict(format!(
                    "managed link was replaced with a different filesystem object: {}",
                    removal.link_path.display()
                )));
            }
            let deployed_target = fs::canonicalize(&removal.link_path).map_err(|error| {
                AppError::Conflict(format!(
                    "managed link target cannot be verified and was not removed: {error}"
                ))
            })?;
            let object_metadata = metadata_without_links(&removal.object_path, "managed object")
                .map_err(|error| {
                    AppError::Conflict(format!(
                        "recorded managed object cannot be verified: {error}"
                    ))
                })?;
            if !object_metadata.is_dir() {
                return Err(AppError::Conflict(
                    "recorded managed object is not a directory".to_owned(),
                ));
            }
            let recorded_object = fs::canonicalize(&removal.object_path).map_err(|error| {
                AppError::Conflict(format!(
                    "recorded managed object cannot be resolved: {error}"
                ))
            })?;
            if !binding_paths_equal(&deployed_target, &recorded_object) {
                return Err(AppError::Conflict(format!(
                    "managed link target does not match its recorded immutable object: {}",
                    removal.link_path.display()
                )));
            }
        }
        mode => {
            return Err(AppError::Conflict(format!(
                "unknown managed binding mode '{mode}'"
            )))
        }
    }
    Ok(DeploymentPresence::Present)
}

fn remove_validated_deployment(removal: &ManagedBindingRemoval) -> AppResult<DeploymentPresence> {
    let presence = validate_managed_deployment(removal)?;
    if presence == DeploymentPresence::Missing {
        return Ok(presence);
    }
    match removal.link_mode.as_str() {
        "copy" => remove_tree(&removal.link_path)?,
        "junction" | "symlink" => {
            #[cfg(windows)]
            fs::remove_dir(&removal.link_path)?;
            #[cfg(not(windows))]
            fs::remove_file(&removal.link_path)?;
        }
        mode => {
            return Err(AppError::Conflict(format!(
                "unknown managed binding mode '{mode}'"
            )))
        }
    }
    Ok(DeploymentPresence::Present)
}

fn finish_uninstall_operation_failed(
    database: &Database,
    operation_id: &str,
    location_id: &str,
    error: &AppError,
) -> AppResult<()> {
    let now = Utc::now().timestamp();
    database.with_connection(|connection| {
        let transaction = connection.unchecked_transaction()?;
        transaction.execute(
            "UPDATE operations
             SET state = 'failed', current_step = 'failed', error_json = ?1, finished_at = ?2
             WHERE id = ?3",
            params![
                serde_json::json!({"message": error.to_string()}).to_string(),
                now,
                operation_id
            ],
        )?;
        transaction.execute(
            "INSERT INTO audit_logs(action_type, target_id, result, detail_json, created_at)
             VALUES ('SKILL_UNINSTALL', ?1, 'failed', ?2, ?3)",
            params![
                location_id,
                serde_json::json!({
                    "operationId": operation_id,
                    "message": error.to_string(),
                })
                .to_string(),
                now
            ],
        )?;
        transaction.commit()?;
        Ok(())
    })
}

fn finish_operation_failed(
    database: &Database,
    operation_id: &str,
    error: &AppError,
) -> AppResult<()> {
    let now = Utc::now().timestamp();
    database.with_connection(|connection| {
        connection.execute(
            "UPDATE operations
             SET state = 'failed', current_step = 'rolled_back', error_json = ?1, finished_at = ?2
             WHERE id = ?3",
            params![
                serde_json::json!({"message": error.to_string()}).to_string(),
                now,
                operation_id
            ],
        )?;
        connection.execute(
            "INSERT INTO audit_logs(action_type, target_id, result, detail_json, created_at)
             VALUES ('SKILL_IMPORT', ?1, 'failed', ?2, ?3)",
            params![
                operation_id,
                serde_json::json!({"message": error.to_string()}).to_string(),
                now
            ],
        )?;
        Ok(())
    })
}

pub fn recover_interrupted_operations(database: &Database, app_data_dir: &Path) -> AppResult<()> {
    let staging_root = app_data_dir.join("skills-store").join("staging");
    if let Ok(entries) = fs::read_dir(&staging_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.parent() == Some(staging_root.as_path()) && path.is_dir() {
                let _ = remove_tree(&path);
            }
        }
    }

    let now = Utc::now().timestamp();
    database.with_connection(|connection| {
        let interrupted = {
            let mut statement = connection.prepare(
                "SELECT id, request_json FROM operations
                 WHERE state = 'running' AND operation_type = 'SKILL_IMPORT'",
            )?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let transaction = connection.unchecked_transaction()?;
        for (id, request_json) in interrupted {
            let detail = serde_json::from_str::<serde_json::Value>(&request_json)
                .unwrap_or_else(|_| serde_json::json!({}));
            transaction.execute(
                "UPDATE operations
                 SET state = 'interrupted', current_step = 'manual_reconcile_required',
                     error_json = ?1, finished_at = ?2
                 WHERE id = ?3",
                params![
                    serde_json::json!({
                        "message": "the app exited during deployment; recorded paths were not deleted automatically",
                        "request": detail,
                    })
                    .to_string(),
                    now,
                    id
                ],
            )?;
            transaction.execute(
                "INSERT INTO audit_logs(action_type, target_id, result, detail_json, created_at)
                 VALUES ('IMPORT_RECOVERY', ?1, 'interrupted', ?2, ?3)",
                params![id, request_json, now],
            )?;
        }
        transaction.commit()?;
        Ok(())
    })
}

pub fn set_skill_enabled(database: &Database, location_id: &str, enabled: bool) -> AppResult<()> {
    let (agent_type, skill_path, project_trusted): (String, String, i64) = database
        .with_connection(|connection| {
            connection
                .query_row(
                    "SELECT l.agent_type, l.skill_path, COALESCE(p.trusted, 1)
                     FROM skill_locations l
                     LEFT JOIN projects p ON p.id = l.project_id
                     WHERE l.id = ?1",
                    [location_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .map_err(AppError::from)
        })?;
    if agent_type != "codex" {
        return Err(AppError::Unsupported(format!(
            "{} does not expose a stable per-skill enablement contract",
            agent_type
        )));
    }
    if project_trusted == 0 {
        return Err(AppError::Unsupported(
            "project must be trusted before enabling its skills".to_owned(),
        ));
    }
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::Internal("home directory unavailable".to_owned()))?;
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    fs::create_dir_all(&codex_home)?;
    let config_path = codex_home.join("config.toml");
    update_codex_skill_config(&config_path, &skill_path, enabled)?;
    database.with_connection(|connection| {
        connection.execute(
            "UPDATE skill_locations SET enabled_state = ?1 WHERE id = ?2",
            params![if enabled { "enabled" } else { "disabled" }, location_id],
        )?;
        connection.execute(
            "INSERT INTO audit_logs(action_type, target_id, result, detail_json, created_at) VALUES ('SKILL_ENABLE', ?1, 'success', ?2, ?3)",
            params![location_id, serde_json::json!({"enabled": enabled}).to_string(), Utc::now().timestamp()],
        )?;
        Ok(())
    })
}

pub fn write_skill_file(
    database: &Database,
    request: &WriteSkillFileRequest,
) -> AppResult<WriteSkillFileResult> {
    let (root, read_only, project_trusted, skill_id, link_kind, metadata_json): (
        String,
        i64,
        i64,
        String,
        String,
        String,
    ) = database.with_connection(|connection| {
        connection
            .query_row(
                "SELECT l.canonical_path, l.read_only, COALESCE(p.trusted, 1),
                            s.id, l.link_kind, l.metadata_json
                     FROM skill_locations l
                     JOIN skills s ON s.id = l.skill_id
                     LEFT JOIN projects p ON p.id = l.project_id
                     WHERE l.id = ?1",
                [&request.location_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .map_err(AppError::from)
    })?;
    if read_only != 0 {
        return Err(AppError::Unsupported(
            "skill source is read-only".to_owned(),
        ));
    }
    if project_trusted == 0 {
        return Err(AppError::Unsupported(
            "project must be trusted before editing its skills".to_owned(),
        ));
    }
    let root = fs::canonicalize(root)?;
    let relative = validated_relative_path(&request.relative_path)?;
    let manifest_update = if relative == Path::new("SKILL.md") {
        let fallback_name = root
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("unnamed-skill");
        Some(skills::index_skill_manifest(
            &request.content,
            fallback_name,
            &link_kind,
        ))
    } else {
        None
    };
    let target = root.join(&relative);
    let parent = target
        .parent()
        .ok_or_else(|| AppError::InvalidInput("invalid target file".to_owned()))?;
    let canonical_parent = fs::canonicalize(parent)?;
    if !canonical_parent.starts_with(&root) {
        return Err(AppError::InvalidInput("path escapes skill root".to_owned()));
    }
    let current = fs::read(&target)?;
    let current_hash = hex::encode(Sha256::digest(&current));
    if current_hash != request.expected_hash {
        return Err(AppError::Conflict(
            "skill file changed outside the editor".to_owned(),
        ));
    }
    let temp = parent.join(format!(".ccc-write-{}", Uuid::new_v4()));
    {
        let mut file = fs::File::create(&temp)?;
        file.write_all(request.content.as_bytes())?;
        file.sync_all()?;
    }
    let backup = parent.join(format!(".ccc-backup-{}", Uuid::new_v4()));
    fs::copy(&target, &backup)?;
    if let Err(error) = replace_existing_file(&temp, &target) {
        let _ = fs::remove_file(&temp);
        return Err(error.into());
    }
    let _ = fs::remove_file(&backup);
    let content_hash = hex::encode(Sha256::digest(request.content.as_bytes()));
    let updated_at = Utc::now().timestamp();
    database.with_connection(|connection| {
        let transaction = connection.unchecked_transaction()?;
        if let Some(indexed) = manifest_update {
            let mut metadata = serde_json::from_str::<serde_json::Value>(&metadata_json)
                .unwrap_or_else(|_| serde_json::json!({}));
            if !metadata.is_object() {
                metadata = serde_json::json!({});
            }
            if let Some(object) = metadata.as_object_mut() {
                object.insert("frontmatter".to_owned(), indexed.frontmatter);
                object.insert(
                    "parseError".to_owned(),
                    indexed
                        .parse_error
                        .map(serde_json::Value::String)
                        .unwrap_or(serde_json::Value::Null),
                );
            }
            transaction.execute(
                "UPDATE skills
                 SET logical_name = ?1, display_name = ?2, description = ?3, updated_at = ?4
                 WHERE id = ?5",
                params![
                    indexed.name,
                    indexed.display_name,
                    indexed.description,
                    updated_at,
                    skill_id,
                ],
            )?;
            transaction.execute(
                "UPDATE skill_locations
                 SET observed_hash = ?1, last_seen_at = ?2, health_status = ?3, metadata_json = ?4
                 WHERE id = ?5",
                params![
                    content_hash,
                    updated_at,
                    indexed.health_status,
                    metadata.to_string(),
                    request.location_id,
                ],
            )?;
        } else {
            transaction.execute(
                "UPDATE skill_locations SET last_seen_at = ?1 WHERE id = ?2",
                params![updated_at, request.location_id],
            )?;
        }
        transaction.execute(
            "INSERT INTO audit_logs(action_type, target_id, result, detail_json, created_at) VALUES ('SKILL_FILE_WRITE', ?1, 'success', ?2, ?3)",
            params![request.location_id, serde_json::json!({"path": request.relative_path}).to_string(), updated_at],
        )?;
        transaction.commit()?;
        Ok(())
    })?;
    Ok(WriteSkillFileResult {
        content_hash,
        updated_at,
    })
}

fn parse_skill(path: &Path) -> AppResult<ParsedSkill> {
    let content = fs::read_to_string(path)?;
    let frontmatter = content
        .strip_prefix("---")
        .and_then(|rest| rest.split_once("\n---"))
        .map(|(value, _)| value)
        .ok_or_else(|| {
            AppError::InvalidInput("SKILL.md must contain YAML frontmatter".to_owned())
        })?;
    let mut values = BTreeMap::new();
    for line in frontmatter.lines() {
        if line.starts_with(char::is_whitespace) {
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            values.insert(
                key.trim().to_owned(),
                value.trim().trim_matches(['\'', '"']).to_owned(),
            );
        }
    }
    let name = values
        .remove("name")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::InvalidInput("skill frontmatter requires name".to_owned()))?;
    let description = values
        .remove("description")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AppError::InvalidInput("skill frontmatter requires description".to_owned())
        })?;
    Ok(ParsedSkill { name, description })
}

fn metadata_without_links(path: &Path, context: &str) -> AppResult<fs::Metadata> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata_is_link_like(&metadata) {
        return Err(AppError::InvalidInput(format!(
            "{context} contains a symbolic link or Windows reparse point: {}",
            path.display()
        )));
    }
    Ok(metadata)
}

fn metadata_is_link_like(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn tree_path_metadata(root: &Path, relative: &Path, context: &str) -> AppResult<fs::Metadata> {
    let mut current = root.to_path_buf();
    let mut metadata = metadata_without_links(&current, context)?;
    if !metadata.is_dir() {
        return Err(AppError::InvalidInput(format!(
            "{context} root must be a directory: {}",
            root.display()
        )));
    }
    for component in relative.components() {
        match component {
            Component::Normal(value) => current.push(value),
            Component::CurDir => continue,
            _ => {
                return Err(AppError::InvalidInput(format!(
                    "{context} path escapes its root: {}",
                    relative.display()
                )))
            }
        }
        metadata = metadata_without_links(&current, context)?;
    }
    Ok(metadata)
}

fn create_tree_directories(root: &Path, relative: &Path) -> AppResult<()> {
    let root_metadata = metadata_without_links(root, "copy destination")?;
    if !root_metadata.is_dir() {
        return Err(AppError::InvalidInput(format!(
            "copy destination root must be a directory: {}",
            root.display()
        )));
    }
    let mut current = root.to_path_buf();
    for component in relative.components() {
        match component {
            Component::Normal(value) => current.push(value),
            Component::CurDir => continue,
            _ => {
                return Err(AppError::InvalidInput(format!(
                    "copy destination path escapes its root: {}",
                    relative.display()
                )))
            }
        }
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata_is_link_like(&metadata) {
                    return Err(AppError::InvalidInput(format!(
                        "copy destination contains a symbolic link or Windows reparse point: {}",
                        current.display()
                    )));
                }
                if !metadata.is_dir() {
                    return Err(AppError::InvalidInput(format!(
                        "copy destination component is not a directory: {}",
                        current.display()
                    )));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current)?;
                let metadata = metadata_without_links(&current, "copy destination")?;
                if !metadata.is_dir() {
                    return Err(AppError::InvalidInput(format!(
                        "copy destination component is not a directory: {}",
                        current.display()
                    )));
                }
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn hash_tree(root: &Path) -> AppResult<(String, Vec<PathBuf>)> {
    let root_metadata = metadata_without_links(root, "skill tree")?;
    if !root_metadata.is_dir() {
        return Err(AppError::InvalidInput(format!(
            "skill tree root must be a directory: {}",
            root.display()
        )));
    }
    let mut paths = Vec::new();
    let mut total_size = 0_u64;
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = entry.map_err(|error| AppError::Io(error.into()))?;
        if entry.path() == root {
            continue;
        }
        let metadata = metadata_without_links(entry.path(), "skill tree")?;
        if metadata.is_file() {
            total_size = total_size.saturating_add(metadata.len());
            if total_size > MAX_IMPORT_BYTES || paths.len() >= MAX_IMPORT_FILES {
                return Err(AppError::InvalidInput(
                    "skill import exceeds safety limits".to_owned(),
                ));
            }
            paths.push(entry.path().strip_prefix(root).unwrap().to_path_buf());
        }
    }
    paths.sort();
    let mut digest = Sha256::new();
    for relative in &paths {
        let portable_path = relative.to_string_lossy().replace('\\', "/");
        digest.update(portable_path.as_bytes());
        digest.update([0]);
        let metadata = tree_path_metadata(root, relative, "skill tree")?;
        if !metadata.is_file() {
            return Err(AppError::InvalidInput(format!(
                "skill tree entry changed while hashing: {}",
                root.join(relative).display()
            )));
        }
        let mut file = fs::File::open(root.join(relative))?;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            digest.update(&buffer[..read]);
        }
        digest.update([0xff]);
    }
    Ok((hex::encode(digest.finalize()), paths))
}

fn copy_tree(source: &Path, destination: &Path, files: &[PathBuf]) -> AppResult<()> {
    let source_metadata = metadata_without_links(source, "copy source")?;
    if !source_metadata.is_dir() {
        return Err(AppError::InvalidInput(format!(
            "copy source root must be a directory: {}",
            source.display()
        )));
    }
    let destination_metadata = metadata_without_links(destination, "copy destination")?;
    if !destination_metadata.is_dir() {
        return Err(AppError::InvalidInput(format!(
            "copy destination root must be a directory: {}",
            destination.display()
        )));
    }
    for relative in files {
        let source_metadata = tree_path_metadata(source, relative, "copy source")?;
        if !source_metadata.is_file() {
            return Err(AppError::InvalidInput(format!(
                "copy source entry is not a file: {}",
                source.join(relative).display()
            )));
        }
        let target = destination.join(relative);
        if let Some(parent) = relative.parent() {
            create_tree_directories(destination, parent)?;
        }
        if fs::symlink_metadata(&target).is_ok() {
            let existing = metadata_without_links(&target, "copy destination")?;
            if !existing.is_file() {
                return Err(AppError::InvalidInput(format!(
                    "copy destination entry is not a file: {}",
                    target.display()
                )));
            }
        }
        fs::copy(source.join(relative), target)?;
        let copied = tree_path_metadata(destination, relative, "copy destination")?;
        if !copied.is_file() {
            return Err(AppError::InvalidInput(format!(
                "copied entry is not a regular file: {}",
                destination.join(relative).display()
            )));
        }
    }
    Ok(())
}

fn make_tree_read_only(root: &Path) -> AppResult<()> {
    let root_metadata = metadata_without_links(root, "managed object")?;
    if !root_metadata.is_dir() {
        return Err(AppError::InvalidInput(format!(
            "managed object root must be a directory: {}",
            root.display()
        )));
    }
    let mut entries = Vec::new();
    for entry in WalkDir::new(root).follow_links(false) {
        entries.push(entry.map_err(|error| AppError::Io(error.into()))?);
    }
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.depth()));
    for entry in entries {
        let metadata = metadata_without_links(entry.path(), "managed object")?;
        let mut permissions = metadata.permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            permissions.set_mode(if metadata.is_dir() { 0o555 } else { 0o444 });
            fs::set_permissions(entry.path(), permissions)?;
        }
        #[cfg(windows)]
        if metadata.is_file() {
            permissions.set_readonly(true);
            fs::set_permissions(entry.path(), permissions)?;
        }
    }
    Ok(())
}

fn remove_tree(root: &Path) -> AppResult<()> {
    let root_metadata = match fs::symlink_metadata(root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if metadata_is_link_like(&root_metadata) || !root_metadata.is_dir() {
        return Err(AppError::Conflict(format!(
            "refusing to recursively remove a link, reparse point, or non-directory: {}",
            root.display()
        )));
    }
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = entry.map_err(|error| AppError::Io(error.into()))?;
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata_is_link_like(&metadata) {
            return Err(AppError::Conflict(format!(
                "refusing to recursively remove a tree containing a link or reparse point: {}",
                entry.path().display()
            )));
        }
    }
    #[cfg(windows)]
    #[allow(clippy::permissions_set_readonly_false)]
    for entry in WalkDir::new(root).follow_links(false).into_iter().flatten() {
        if let Ok(metadata) = entry.metadata() {
            if metadata.is_file() && metadata.permissions().readonly() {
                let mut permissions = metadata.permissions();
                permissions.set_readonly(false);
                let _ = fs::set_permissions(entry.path(), permissions);
            }
        }
    }
    fs::remove_dir_all(root)?;
    Ok(())
}

fn resolve_target_root(database: &Database, target: &DeploymentTarget) -> AppResult<PathBuf> {
    let base = match target.scope_kind.as_str() {
        "user" => dirs::home_dir()
            .ok_or_else(|| AppError::Internal("home directory unavailable".to_owned()))?,
        "project" => {
            let project_id = target.project_id.as_deref().ok_or_else(|| {
                AppError::InvalidInput("project target requires projectId".to_owned())
            })?;
            let (root, trusted) = database.with_connection(|connection| {
                connection
                    .query_row(
                        "SELECT root_path, trusted FROM projects WHERE id = ?1",
                        [project_id],
                        |row| {
                            Ok((
                                PathBuf::from(row.get::<_, String>(0)?),
                                row.get::<_, i64>(1)?,
                            ))
                        },
                    )
                    .map_err(AppError::from)
            })?;
            if trusted == 0 {
                return Err(AppError::Unsupported(
                    "project must be trusted before deploying skills".to_owned(),
                ));
            }
            root
        }
        value => {
            return Err(AppError::InvalidInput(format!(
                "unsupported target scope: {value}"
            )))
        }
    };
    let suffix = match target.agent_type.as_str() {
        "codex" => PathBuf::from(".agents").join("skills"),
        "claude" => PathBuf::from(".claude").join("skills"),
        "cursor" => PathBuf::from(".cursor").join("skills"),
        value => {
            return Err(AppError::InvalidInput(format!(
                "unsupported agent: {value}"
            )))
        }
    };
    Ok(base.join(suffix))
}

fn safe_slug(name: &str) -> String {
    let mut slug = String::new();
    for character in name.chars() {
        if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
            slug.push(character.to_ascii_lowercase());
        } else if character.is_whitespace() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    slug.trim_matches('-').to_owned()
}

fn create_directory_binding(
    target: &Path,
    link: &Path,
    allow_copy_fallback: bool,
) -> AppResult<String> {
    #[cfg(target_os = "windows")]
    {
        if junction::create(target, link).is_ok() {
            return Ok("junction".to_owned());
        }
    }
    #[cfg(unix)]
    {
        if std::os::unix::fs::symlink(target, link).is_ok() {
            return Ok("symlink".to_owned());
        }
    }
    if allow_copy_fallback {
        let (expected_hash, files) = hash_tree(target)?;
        fs::create_dir_all(link)?;
        if let Err(error) = copy_tree(target, link, &files) {
            let _ = remove_tree(link);
            return Err(error);
        }
        let copied_hash = match hash_tree(link) {
            Ok((hash, _)) => hash,
            Err(error) => {
                let _ = remove_tree(link);
                return Err(error);
            }
        };
        if copied_hash != expected_hash {
            let _ = remove_tree(link);
            return Err(AppError::Conflict(
                "copied skill failed integrity verification".to_owned(),
            ));
        }
        return Ok("copy".to_owned());
    }
    Err(AppError::Unsupported(format!(
        "the filesystem cannot create a managed directory link at {}",
        link.display()
    )))
}

fn rollback_bindings(bindings: &[(DeploymentTarget, PathBuf, String)]) {
    for (_, path, mode) in bindings.iter().rev() {
        if mode == "copy" {
            let _ = remove_tree(path);
        } else {
            let _ = fs::remove_dir(path);
        }
    }
}

fn update_codex_skill_config(path: &Path, skill_path: &str, enabled: bool) -> AppResult<()> {
    let content = if path.exists() {
        fs::read_to_string(path)?
    } else {
        String::new()
    };
    let mut document = if content.trim().is_empty() {
        DocumentMut::new()
    } else {
        content
            .parse::<DocumentMut>()
            .map_err(|error| AppError::Conflict(format!("config.toml is invalid: {error}")))?
    };
    if !document.contains_key("skills") {
        document["skills"] = Item::Table(Table::new());
    }
    let skills = document["skills"]
        .as_table_mut()
        .ok_or_else(|| AppError::Conflict("config.toml skills value is not a table".to_owned()))?;
    if !skills.contains_key("config") {
        skills["config"] = Item::ArrayOfTables(ArrayOfTables::new());
    }
    let entries = skills["config"].as_array_of_tables_mut().ok_or_else(|| {
        AppError::Conflict("config.toml skills.config is not an array of tables".to_owned())
    })?;
    let normalized = Path::new(skill_path).join("SKILL.md");
    let normalized_string = if skill_path.ends_with("SKILL.md") {
        skill_path.to_owned()
    } else {
        normalized.to_string_lossy().into_owned()
    };
    let mut found = false;
    for entry in entries.iter_mut() {
        if entry
            .get("path")
            .and_then(Item::as_str)
            .is_some_and(|existing| config_paths_equal(existing, &normalized_string))
        {
            entry["enabled"] = value(enabled);
            found = true;
        }
    }
    if !found {
        let mut entry = Table::new();
        entry["path"] = value(normalized_string);
        entry["enabled"] = value(enabled);
        entries.push(entry);
    }
    atomic_replace(path, document.to_string().as_bytes())
}

fn config_paths_equal(left: &str, right: &str) -> bool {
    #[cfg(windows)]
    {
        fn key(value: &str) -> String {
            let normalized = value.replace('/', "\\");
            normalized
                .strip_prefix(r"\\?\")
                .unwrap_or(&normalized)
                .trim_end_matches('\\')
                .to_lowercase()
        }
        key(left) == key(right)
    }
    #[cfg(not(windows))]
    {
        left.trim_end_matches('/') == right.trim_end_matches('/')
    }
}

fn binding_paths_equal(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    fn key(path: &Path) -> String {
        let mut value = path.to_string_lossy().replace('\\', "/");
        let lowercase = value.to_ascii_lowercase();
        if lowercase.starts_with("//?/unc/") {
            value = format!("//{}", &value[8..]);
        } else if lowercase.starts_with("//?/") {
            value = value[4..].to_owned();
        }

        let prefix = if value.starts_with("//") {
            "//"
        } else if value.starts_with('/') {
            "/"
        } else {
            ""
        };
        let mut components = Vec::new();
        for component in value.split('/') {
            match component {
                "" | "." => {}
                ".." => {
                    let can_pop = components.last().is_some_and(|previous: &&str| {
                        *previous != ".." && !previous.ends_with(':')
                    });
                    if can_pop {
                        components.pop();
                    } else if prefix.is_empty() {
                        components.push(component);
                    }
                }
                _ => components.push(component),
            }
        }
        format!("{prefix}{}", components.join("/")).to_lowercase()
    }

    #[cfg(windows)]
    {
        key(left) == key(right)
    }
    #[cfg(not(windows))]
    {
        config_paths_equal(&left.to_string_lossy(), &right.to_string_lossy())
    }
}

fn binding_scopes_equal(binding_scope: &str, location_scope: &str) -> bool {
    binding_scope == location_scope
        || matches!(
            (binding_scope, location_scope),
            ("project", "repo") | ("repo", "project")
        )
}

fn atomic_replace(path: &Path, content: &[u8]) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::InvalidInput("invalid configuration path".to_owned()))?;
    fs::create_dir_all(parent)?;
    let temp = parent.join(format!(".ccc-config-{}", Uuid::new_v4()));
    {
        let mut file = fs::File::create(&temp)?;
        file.write_all(content)?;
        file.sync_all()?;
    }
    if !path.exists() {
        fs::rename(temp, path)?;
        return Ok(());
    }
    let backup = path.with_extension("toml.ccc-backup");
    if backup.exists() {
        fs::remove_file(&backup)?;
    }
    fs::copy(path, &backup)?;
    if let Err(error) = replace_existing_file(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(error.into());
    }
    Ok(())
}

#[cfg(windows)]
fn replace_existing_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_existing_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

fn validated_relative_path(value: &str) -> AppResult<PathBuf> {
    let path = Path::new(value);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(AppError::InvalidInput(
            "file path must stay inside the skill".to_owned(),
        ));
    }
    Ok(path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_is_safe_and_stable() {
        assert_eq!(safe_slug("Deploy Helper"), "deploy-helper");
        assert_eq!(safe_slug("pdf_tools"), "pdf_tools");
        assert!(safe_slug("部署助手").is_empty());
    }

    #[test]
    fn relative_path_rejects_escape() {
        assert!(validated_relative_path("scripts/check.sh").is_ok());
        assert!(validated_relative_path("../secret").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn config_paths_match_windows_equivalents() {
        assert!(config_paths_equal(
            r"C:\Users\ExampleUser\.agents\skills\PDF\SKILL.md",
            r"\\?\c:/users/exampleuser/.agents/skills/pdf/SKILL.md"
        ));
    }

    #[test]
    fn untrusted_projects_reject_deployment_targets() {
        let app_data = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let database = Database::open(app_data.path()).unwrap();
        database
            .with_connection(|connection| {
                connection.execute(
                    "INSERT INTO projects(id, name, root_path, trusted, created_at, updated_at)
                     VALUES ('project-1', 'Project', ?1, 0, 1, 1)",
                    [project.path().to_string_lossy().as_ref()],
                )?;
                Ok(())
            })
            .unwrap();

        let target = DeploymentTarget {
            agent_type: "codex".to_owned(),
            scope_kind: "project".to_owned(),
            project_id: Some("project-1".to_owned()),
        };
        assert!(matches!(
            resolve_target_root(&database, &target),
            Err(AppError::Unsupported(_))
        ));
    }

    fn create_test_directory_link(target: &Path, link: &Path) {
        #[cfg(windows)]
        junction::create(target, link).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    fn test_directory_link_mode() -> &'static str {
        if cfg!(windows) {
            "junction"
        } else {
            "symlink"
        }
    }

    fn copy_test_tree(source: &Path, destination: &Path) {
        let (_, files) = hash_tree(source).unwrap();
        fs::create_dir_all(destination).unwrap();
        copy_tree(source, destination, &files).unwrap();
    }

    #[test]
    fn recursive_removal_rejects_a_link_root() {
        let target = tempfile::tempdir().unwrap();
        let container = tempfile::tempdir().unwrap();
        fs::write(target.path().join("payload.txt"), "keep").unwrap();
        let linked_root = container.path().join("linked-root");
        create_test_directory_link(target.path(), &linked_root);

        assert!(matches!(
            remove_tree(&linked_root),
            Err(AppError::Conflict(_))
        ));
        assert!(fs::symlink_metadata(&linked_root).is_ok());
        assert_eq!(
            fs::read_to_string(target.path().join("payload.txt")).unwrap(),
            "keep"
        );
    }

    fn register_removal_fixture(
        database: &Database,
        object_path: &Path,
        deployment_path: &Path,
        link_mode: &str,
        managed: bool,
        project_trusted: Option<bool>,
    ) {
        let (tree_hash, _) = hash_tree(object_path).unwrap();
        let binding_scope_kind = if project_trusted.is_some() {
            "project"
        } else {
            "user"
        };
        let location_scope_kind = if project_trusted.is_some() {
            "repo"
        } else {
            "user"
        };
        let project_id = project_trusted.map(|_| "project-removal");
        let canonical_path =
            fs::canonicalize(deployment_path).unwrap_or_else(|_| deployment_path.to_path_buf());
        database
            .with_connection(|connection| {
                let transaction = connection.unchecked_transaction()?;
                if let Some(trusted) = project_trusted {
                    transaction.execute(
                        "INSERT INTO projects(id, name, root_path, trusted, created_at, updated_at)
                         VALUES ('project-removal', 'Project', ?1, ?2, 1, 1)",
                        params![
                            deployment_path
                                .parent()
                                .unwrap_or(deployment_path)
                                .to_string_lossy(),
                            i64::from(trusted)
                        ],
                    )?;
                }
                transaction.execute(
                    "INSERT INTO skills(
                        id, logical_name, display_name, description, source_kind, source_uri,
                        managed, active_revision_id, created_at, updated_at
                     ) VALUES (
                        'skill-removal', 'removal-fixture', 'Removal fixture', '', 'local-import',
                        ?1, ?2, 'revision-removal', 1, 1
                     )",
                    params![object_path.to_string_lossy(), i64::from(managed)],
                )?;
                transaction.execute(
                    "INSERT INTO skill_revisions(
                        id, skill_id, tree_hash, object_path, manifest_json, scan_status, created_at
                     ) VALUES (
                        'revision-removal', 'skill-removal', ?1, ?2, '{}', 'review', 1
                     )",
                    params![tree_hash, object_path.to_string_lossy()],
                )?;
                transaction.execute(
                    "INSERT INTO skill_bindings(
                        id, skill_id, revision_id, agent_type, scope_kind, target_root,
                        link_path, link_mode, health_status, created_at, updated_at
                     ) VALUES (
                        'binding-removal', 'skill-removal', 'revision-removal', 'codex', ?1, ?2,
                        ?3, ?4, 'ok', 1, 1
                     )",
                    params![
                        binding_scope_kind,
                        deployment_path
                            .parent()
                            .unwrap_or(deployment_path)
                            .to_string_lossy(),
                        deployment_path.to_string_lossy(),
                        link_mode
                    ],
                )?;
                transaction.execute(
                    "INSERT INTO skill_locations(
                        id, skill_id, agent_type, scope_kind, project_id, skill_path,
                        canonical_path, enabled_state, read_only, link_kind, health_status,
                        last_seen_at, metadata_json
                     ) VALUES (
                        'location-removal', 'skill-removal', 'codex', ?1, ?2, ?3, ?4,
                        'enabled', 1, ?5, 'ok', 1, '{}'
                     )",
                    params![
                        location_scope_kind,
                        project_id,
                        deployment_path.to_string_lossy(),
                        canonical_path.to_string_lossy(),
                        link_mode
                    ],
                )?;
                transaction.commit()?;
                Ok(())
            })
            .unwrap();
    }

    fn table_count(database: &Database, table: &str) -> i64 {
        database
            .with_connection(|connection| {
                connection
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                        row.get(0)
                    })
                    .map_err(AppError::from)
            })
            .unwrap()
    }

    fn latest_operation_state(database: &Database) -> String {
        database
            .with_connection(|connection| {
                connection
                    .query_row(
                        "SELECT state FROM operations ORDER BY rowid DESC LIMIT 1",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(AppError::from)
            })
            .unwrap()
    }

    fn latest_uninstall_audit(database: &Database) -> String {
        database
            .with_connection(|connection| {
                connection
                    .query_row(
                        "SELECT result FROM audit_logs
                         WHERE action_type = 'SKILL_UNINSTALL'
                         ORDER BY id DESC LIMIT 1",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(AppError::from)
            })
            .unwrap()
    }

    #[test]
    fn removing_managed_link_keeps_immutable_object_and_cleans_records() {
        let app_data = tempfile::tempdir().unwrap();
        let object = tempfile::tempdir().unwrap();
        let deployments = tempfile::tempdir().unwrap();
        fs::write(object.path().join("SKILL.md"), "managed link").unwrap();
        let deployment = deployments.path().join("managed-link");
        create_test_directory_link(object.path(), &deployment);
        let database = Database::open(app_data.path()).unwrap();
        register_removal_fixture(
            &database,
            object.path(),
            &deployment,
            test_directory_link_mode(),
            true,
            None,
        );

        remove_managed_binding(&database, "location-removal").unwrap();

        assert!(fs::symlink_metadata(&deployment).is_err());
        assert_eq!(
            fs::read_to_string(object.path().join("SKILL.md")).unwrap(),
            "managed link"
        );
        assert_eq!(table_count(&database, "skill_locations"), 0);
        assert_eq!(table_count(&database, "skill_bindings"), 0);
        assert_eq!(table_count(&database, "skills"), 1);
        assert_eq!(table_count(&database, "skill_revisions"), 1);
        assert_eq!(latest_operation_state(&database), "completed");
        assert_eq!(latest_uninstall_audit(&database), "success");
    }

    #[test]
    fn removing_verified_managed_copy_keeps_immutable_object() {
        let app_data = tempfile::tempdir().unwrap();
        let object = tempfile::tempdir().unwrap();
        let deployments = tempfile::tempdir().unwrap();
        fs::write(object.path().join("SKILL.md"), "managed copy").unwrap();
        fs::create_dir(object.path().join("scripts")).unwrap();
        fs::write(object.path().join("scripts/check.txt"), "checked").unwrap();
        let deployment = deployments.path().join("managed-copy");
        copy_test_tree(object.path(), &deployment);
        let database = Database::open(app_data.path()).unwrap();
        register_removal_fixture(&database, object.path(), &deployment, "copy", true, None);

        remove_managed_binding(&database, "location-removal").unwrap();

        assert!(!deployment.exists());
        assert!(object.path().join("SKILL.md").exists());
        assert_eq!(table_count(&database, "skill_locations"), 0);
        assert_eq!(table_count(&database, "skill_bindings"), 0);
        assert_eq!(table_count(&database, "skills"), 1);
        assert_eq!(table_count(&database, "skill_revisions"), 1);
        assert_eq!(latest_operation_state(&database), "completed");
        assert_eq!(latest_uninstall_audit(&database), "success");
    }

    #[test]
    fn modified_managed_copy_is_rejected_without_deletion() {
        let app_data = tempfile::tempdir().unwrap();
        let object = tempfile::tempdir().unwrap();
        let deployments = tempfile::tempdir().unwrap();
        fs::write(object.path().join("SKILL.md"), "expected").unwrap();
        let deployment = deployments.path().join("managed-copy");
        copy_test_tree(object.path(), &deployment);
        fs::write(deployment.join("SKILL.md"), "locally modified").unwrap();
        let database = Database::open(app_data.path()).unwrap();
        register_removal_fixture(&database, object.path(), &deployment, "copy", true, None);

        assert!(matches!(
            remove_managed_binding(&database, "location-removal"),
            Err(AppError::Conflict(_))
        ));

        assert_eq!(
            fs::read_to_string(deployment.join("SKILL.md")).unwrap(),
            "locally modified"
        );
        assert_eq!(table_count(&database, "skill_locations"), 1);
        assert_eq!(table_count(&database, "skill_bindings"), 1);
        assert_eq!(latest_operation_state(&database), "failed");
        assert_eq!(latest_uninstall_audit(&database), "failed");
    }

    #[test]
    fn managed_link_target_mismatch_is_rejected_without_deletion() {
        let app_data = tempfile::tempdir().unwrap();
        let object = tempfile::tempdir().unwrap();
        let other_target = tempfile::tempdir().unwrap();
        let deployments = tempfile::tempdir().unwrap();
        fs::write(object.path().join("SKILL.md"), "recorded").unwrap();
        fs::write(other_target.path().join("SKILL.md"), "unexpected").unwrap();
        let deployment = deployments.path().join("managed-link");
        create_test_directory_link(other_target.path(), &deployment);
        let database = Database::open(app_data.path()).unwrap();
        register_removal_fixture(
            &database,
            object.path(),
            &deployment,
            test_directory_link_mode(),
            true,
            None,
        );

        assert!(matches!(
            remove_managed_binding(&database, "location-removal"),
            Err(AppError::Conflict(_))
        ));

        assert!(fs::symlink_metadata(&deployment).is_ok());
        assert_eq!(
            fs::read_to_string(deployment.join("SKILL.md")).unwrap(),
            "unexpected"
        );
        assert_eq!(table_count(&database, "skill_locations"), 1);
        assert_eq!(table_count(&database, "skill_bindings"), 1);
        assert_eq!(latest_operation_state(&database), "failed");
        assert_eq!(latest_uninstall_audit(&database), "failed");
    }

    #[test]
    fn unmanaged_location_is_rejected_without_deletion() {
        let app_data = tempfile::tempdir().unwrap();
        let object = tempfile::tempdir().unwrap();
        let deployments = tempfile::tempdir().unwrap();
        fs::write(object.path().join("SKILL.md"), "unmanaged").unwrap();
        let deployment = deployments.path().join("unmanaged-copy");
        copy_test_tree(object.path(), &deployment);
        let database = Database::open(app_data.path()).unwrap();
        register_removal_fixture(&database, object.path(), &deployment, "copy", false, None);

        assert!(matches!(
            remove_managed_binding(&database, "location-removal"),
            Err(AppError::Unsupported(_))
        ));

        assert!(deployment.exists());
        assert_eq!(table_count(&database, "skill_locations"), 1);
        assert_eq!(table_count(&database, "skill_bindings"), 1);
        assert_eq!(table_count(&database, "operations"), 0);
    }

    #[test]
    fn untrusted_project_removal_is_rejected_and_audited() {
        let app_data = tempfile::tempdir().unwrap();
        let object = tempfile::tempdir().unwrap();
        let deployments = tempfile::tempdir().unwrap();
        fs::write(object.path().join("SKILL.md"), "project copy").unwrap();
        let deployment = deployments.path().join("project-copy");
        copy_test_tree(object.path(), &deployment);
        let database = Database::open(app_data.path()).unwrap();
        register_removal_fixture(
            &database,
            object.path(),
            &deployment,
            "copy",
            true,
            Some(false),
        );

        assert!(matches!(
            remove_managed_binding(&database, "location-removal"),
            Err(AppError::Unsupported(_))
        ));

        assert!(deployment.exists());
        assert_eq!(table_count(&database, "skill_locations"), 1);
        assert_eq!(table_count(&database, "skill_bindings"), 1);
        assert_eq!(latest_operation_state(&database), "failed");
        assert_eq!(latest_uninstall_audit(&database), "failed");
    }

    #[test]
    fn trusted_project_binding_with_repo_location_can_be_removed() {
        let app_data = tempfile::tempdir().unwrap();
        let object = tempfile::tempdir().unwrap();
        let deployments = tempfile::tempdir().unwrap();
        fs::write(object.path().join("SKILL.md"), "trusted project copy").unwrap();
        let deployment = deployments.path().join("project-copy");
        copy_test_tree(object.path(), &deployment);
        let database = Database::open(app_data.path()).unwrap();
        register_removal_fixture(
            &database,
            object.path(),
            &deployment,
            "copy",
            true,
            Some(true),
        );

        remove_managed_binding(&database, "location-removal").unwrap();

        assert!(!deployment.exists());
        assert!(object.path().join("SKILL.md").exists());
        assert_eq!(table_count(&database, "skill_locations"), 0);
        assert_eq!(table_count(&database, "skill_bindings"), 0);
        assert_eq!(latest_operation_state(&database), "completed");
        assert_eq!(latest_uninstall_audit(&database), "success");
    }

    #[test]
    fn missing_managed_target_is_cleaned_up_idempotently() {
        let app_data = tempfile::tempdir().unwrap();
        let object = tempfile::tempdir().unwrap();
        let deployments = tempfile::tempdir().unwrap();
        fs::write(object.path().join("SKILL.md"), "missing copy").unwrap();
        let deployment = deployments.path().join("already-missing");
        let database = Database::open(app_data.path()).unwrap();
        register_removal_fixture(&database, object.path(), &deployment, "copy", true, None);

        remove_managed_binding(&database, "location-removal").unwrap();

        assert_eq!(table_count(&database, "skill_locations"), 0);
        assert_eq!(table_count(&database, "skill_bindings"), 0);
        assert_eq!(table_count(&database, "skills"), 1);
        assert_eq!(table_count(&database, "skill_revisions"), 1);
        assert_eq!(latest_operation_state(&database), "completed");
        assert_eq!(latest_uninstall_audit(&database), "success");
    }

    #[cfg(windows)]
    #[test]
    fn import_rejects_a_junction_as_the_source_root() {
        let container = tempfile::tempdir().unwrap();
        let actual_source = tempfile::tempdir().unwrap();
        fs::write(
            actual_source.path().join("SKILL.md"),
            "---\nname: junction-test\ndescription: test fixture\n---\n",
        )
        .unwrap();
        let source_junction = container.path().join("linked-skill");
        junction::create(actual_source.path(), &source_junction).unwrap();

        let app_data = tempfile::tempdir().unwrap();
        let database = Database::open(app_data.path()).unwrap();
        let request = ImportSkillRequest {
            source_path: source_junction.to_string_lossy().into_owned(),
            targets: vec![DeploymentTarget {
                agent_type: "codex".to_owned(),
                scope_kind: "user".to_owned(),
                project_id: None,
            }],
            allow_copy_fallback: false,
        };

        assert!(matches!(
            import_skill(&database, app_data.path(), &request),
            Err(AppError::InvalidInput(message)) if message.contains("reparse point")
        ));
    }

    #[cfg(windows)]
    #[test]
    fn hashing_and_copying_reject_nested_junctions() {
        let source = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("payload.txt"), "outside").unwrap();
        let nested_junction = source.path().join("nested");
        junction::create(outside.path(), &nested_junction).unwrap();

        assert!(matches!(
            hash_tree(source.path()),
            Err(AppError::InvalidInput(message)) if message.contains("reparse point")
        ));

        let destination = tempfile::tempdir().unwrap();
        assert!(matches!(
            copy_tree(
                source.path(),
                destination.path(),
                &[PathBuf::from("nested").join("payload.txt")],
            ),
            Err(AppError::InvalidInput(message)) if message.contains("reparse point")
        ));
    }

    #[cfg(windows)]
    #[test]
    fn copying_rejects_a_junction_destination_root() {
        let source = tempfile::tempdir().unwrap();
        fs::write(source.path().join("payload.txt"), "payload").unwrap();
        let actual_destination = tempfile::tempdir().unwrap();
        let container = tempfile::tempdir().unwrap();
        let destination_junction = container.path().join("destination");
        junction::create(actual_destination.path(), &destination_junction).unwrap();

        assert!(matches!(
            copy_tree(
                source.path(),
                &destination_junction,
                &[PathBuf::from("payload.txt")],
            ),
            Err(AppError::InvalidInput(message)) if message.contains("reparse point")
        ));
    }
}
