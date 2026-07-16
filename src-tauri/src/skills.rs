use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use toml_edit::{DocumentMut, Item};
use unicode_normalization::UnicodeNormalization;
use walkdir::WalkDir;

use crate::{
    db::Database,
    error::{AppError, AppResult},
    models::{SkillDetail, SkillFile, SkillScanRequest, SkillSummary},
    skill_descriptions,
};

#[cfg(not(test))]
use crate::custom_skills;

const MANIFEST_FILE_NAME: &str = "SKILL.md";
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_READ_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SKILL_ENTRIES: usize = 10_000;
const MAX_PLUGIN_CACHE_DEPTH: usize = 12;
const MAX_MANAGED_TREE_BYTES: u64 = 100 * 1024 * 1024;
const MAX_MANAGED_TREE_FILES: usize = 10_000;

#[derive(Debug, Clone)]
struct ProjectRoot {
    id: String,
    root: PathBuf,
}

#[derive(Debug, Clone, Copy)]
enum DiscoveryMode {
    DirectChildren,
    DescendantManifests,
}

#[derive(Debug, Clone)]
struct SkillRoot {
    agent_type: &'static str,
    scope_kind: &'static str,
    source_kind: &'static str,
    root: PathBuf,
    project_id: Option<String>,
    read_only: bool,
    discovery_mode: DiscoveryMode,
    excluded_children: &'static [&'static str],
}

#[derive(Debug)]
struct RootDiscovery {
    candidates: Vec<PathBuf>,
    complete: bool,
}

#[derive(Debug, Clone)]
struct ScannedSkill {
    location_id: String,
    skill_id: String,
    name: String,
    display_name: String,
    description: String,
    agent_type: String,
    scope_kind: String,
    source_kind: String,
    skill_path: String,
    canonical_path: String,
    enabled_state: String,
    read_only: bool,
    managed: bool,
    health_status: String,
    project_id: Option<String>,
    link_kind: String,
    observed_hash: Option<String>,
    metadata: Value,
    last_seen_at: i64,
}

#[derive(Debug, Clone)]
struct ManagedBinding {
    binding_id: String,
    skill_id: String,
    name: String,
    display_name: String,
    description: String,
    source_kind: String,
    revision_id: String,
    object_path: PathBuf,
    tree_hash: String,
    link_mode: String,
}

#[derive(Debug)]
struct StoredSkill {
    summary: SkillSummary,
    skill_path: PathBuf,
    metadata: Value,
}

#[derive(Debug, Default)]
pub(crate) struct ParsedFrontmatter {
    pub(crate) value: Value,
    pub(crate) name: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) display_name: Option<String>,
    pub(crate) error: Option<String>,
}

#[derive(Debug)]
pub(crate) struct IndexedSkillManifest {
    pub(crate) name: String,
    pub(crate) display_name: String,
    pub(crate) description: String,
    pub(crate) frontmatter: Value,
    pub(crate) health_status: String,
    pub(crate) parse_error: Option<String>,
}

/// Reconciles the derived Skills index with the supported local agent roots.
///
/// An empty `project_ids` list means all registered projects. Plugin cache
/// entries are deliberately opt-in because they can be numerous and their
/// presence does not prove that the owning plugin is enabled.
pub fn scan_skills(
    database: &Database,
    request: &SkillScanRequest,
) -> AppResult<Vec<SkillSummary>> {
    let home = dirs::home_dir().ok_or_else(|| {
        AppError::Internal("could not determine the user home directory".to_owned())
    })?;
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));

    scan_skills_from(database, request, &home, &codex_home)
}

fn scan_skills_from(
    database: &Database,
    request: &SkillScanRequest,
    home: &Path,
    codex_home: &Path,
) -> AppResult<Vec<SkillSummary>> {
    let projects = load_projects(database, &request.project_ids)?;
    let roots = build_skill_roots(home, codex_home, &projects, request.include_plugin_cache);
    // Custom Skills live in the application library and are deliberately indexed
    // as a first-class source. Their contents remain writable through the Custom
    // Skills workflow, but the general scanner can preview and audit them.
    #[cfg(not(test))]
    let roots = {
        let mut roots = roots;
        roots.push(SkillRoot {
            agent_type: "custom",
            scope_kind: "library",
            source_kind: "custom",
            root: custom_skills::custom_library_root()?,
            project_id: None,
            read_only: false,
            discovery_mode: DiscoveryMode::DirectChildren,
            excluded_children: &[".staging"],
        });
        roots
    };
    let managed_bindings = load_managed_bindings(database)?;
    let codex_enabled_overrides = load_codex_enabled_overrides(codex_home)?;
    let scan_token = Utc::now().timestamp();

    // A location is identified by its agent and deployment path, not by the
    // resolved link target. This preserves multiple links to one central copy.
    let mut discovered = BTreeMap::<String, ScannedSkill>::new();
    let mut completed_roots = Vec::new();
    for root in &roots {
        let discovery = discover_candidates(root);
        if discovery.complete {
            completed_roots.push(root.clone());
        }
        for candidate in discovery.candidates {
            let mut skill = inspect_candidate(root, &candidate, scan_token);
            apply_managed_binding(&mut skill, &managed_bindings);
            apply_enabled_state(&mut skill, &codex_enabled_overrides);
            discovered.insert(skill.location_id.clone(), skill);
        }
    }

    let skills = discovered.into_values().collect::<Vec<_>>();
    persist_scan(database, &skills, &completed_roots, scan_token)?;
    let mut summaries = to_summaries(&skills);
    database.with_connection(|connection| {
        for summary in &mut summaries {
            summary.risk_status = location_risk_status(connection, &summary.id)?;
        }
        Ok(())
    })?;
    skill_descriptions::apply_description_overlays(database, &mut summaries)?;
    Ok(summaries)
}

fn load_managed_bindings(database: &Database) -> AppResult<HashMap<String, ManagedBinding>> {
    database.with_connection(|connection| {
        let mut statement = connection.prepare(
            "SELECT
                b.id, b.link_path, s.id, s.logical_name, s.display_name,
                s.description, s.source_kind, r.id, r.object_path, r.tree_hash, b.link_mode
             FROM skill_bindings b
             JOIN skills s ON s.id = b.skill_id
             JOIN skill_revisions r ON r.id = s.active_revision_id
             WHERE s.managed = 1
             ORDER BY b.id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                ManagedBinding {
                    binding_id: row.get(0)?,
                    skill_id: row.get(2)?,
                    name: row.get(3)?,
                    display_name: row.get(4)?,
                    description: row.get(5)?,
                    source_kind: row.get(6)?,
                    revision_id: row.get(7)?,
                    object_path: PathBuf::from(row.get::<_, String>(8)?),
                    tree_hash: row.get(9)?,
                    link_mode: row.get(10)?,
                },
            ))
        })?;

        let mut bindings = HashMap::new();
        let mut ambiguous = HashSet::new();
        for row in rows {
            let (_, link_path, binding) = row?;
            let key = path_comparison_key(Path::new(&link_path));
            if ambiguous.contains(&key) {
                continue;
            }
            if bindings.insert(key.clone(), binding).is_some() {
                // SQLite path uniqueness is case-sensitive, while Windows
                // paths are not. Refuse a nondeterministic association if a
                // malformed database contains two equivalent link paths.
                bindings.remove(&key);
                ambiguous.insert(key);
            }
        }
        Ok(bindings)
    })
}

fn apply_managed_binding(skill: &mut ScannedSkill, bindings: &HashMap<String, ManagedBinding>) {
    let key = path_comparison_key(Path::new(&skill.skill_path));
    let Some(binding) = bindings.get(&key) else {
        return;
    };

    skill.skill_id = binding.skill_id.clone();
    skill.name = binding.name.clone();
    skill.display_name = binding.display_name.clone();
    skill.description = binding.description.clone();
    skill.source_kind = binding.source_kind.clone();
    skill.managed = true;
    // Managed bindings expose an immutable content-addressed revision. Editing
    // it in place would invalidate tree_hash and every other binding.
    skill.read_only = true;
    let validation_status = validate_managed_binding(skill, binding);
    if validation_status != "ok" {
        skill.health_status = validation_status.to_owned();
    }
    if let Some(metadata) = skill.metadata.as_object_mut() {
        metadata.insert("managed".to_owned(), Value::Bool(true));
        metadata.insert(
            "managedBindingId".to_owned(),
            Value::String(binding.binding_id.clone()),
        );
        metadata.insert(
            "managedRevisionId".to_owned(),
            Value::String(binding.revision_id.clone()),
        );
        metadata.insert(
            "managedObjectPath".to_owned(),
            Value::String(binding.object_path.to_string_lossy().into_owned()),
        );
        metadata.insert(
            "managedTreeHash".to_owned(),
            Value::String(binding.tree_hash.clone()),
        );
        metadata.insert(
            "managedLinkMode".to_owned(),
            Value::String(binding.link_mode.clone()),
        );
        metadata.insert(
            "managedValidationStatus".to_owned(),
            Value::String(validation_status.to_owned()),
        );
    }
}

fn validate_managed_binding(skill: &ScannedSkill, binding: &ManagedBinding) -> &'static str {
    let resolved_skill = match fs::canonicalize(&skill.skill_path) {
        Ok(path) => path,
        Err(_) => return "target_mismatch",
    };
    let resolved_object = match fs::canonicalize(&binding.object_path) {
        Ok(path) => path,
        Err(_) => return "target_mismatch",
    };
    // Copy fallback deliberately creates an independent deployment tree. Link
    // deployments must still resolve to the immutable central object.
    if binding.link_mode != "copy"
        && path_comparison_key(&resolved_skill) != path_comparison_key(&resolved_object)
    {
        return "target_mismatch";
    }

    match hash_managed_tree(&resolved_skill) {
        Ok(tree_hash) if tree_hash == binding.tree_hash => "ok",
        Ok(_) | Err(_) => "modified",
    }
}

fn hash_managed_tree(root: &Path) -> AppResult<String> {
    let mut paths = Vec::new();
    let mut total_bytes = 0_u64;

    for entry in WalkDir::new(root).follow_links(false) {
        let entry = entry.map_err(|error| AppError::Internal(error.to_string()))?;
        if entry.path() == root {
            continue;
        }
        if entry.file_type().is_symlink() {
            return Err(AppError::InvalidInput(format!(
                "managed skill contains a symbolic link: {}",
                entry.path().display()
            )));
        }
        if !entry.file_type().is_file() {
            continue;
        }

        let metadata = entry
            .metadata()
            .map_err(|error| AppError::Io(error.into()))?;
        total_bytes = total_bytes
            .checked_add(metadata.len())
            .ok_or_else(|| AppError::InvalidInput("managed skill is too large".to_owned()))?;
        if total_bytes > MAX_MANAGED_TREE_BYTES {
            return Err(AppError::InvalidInput(format!(
                "managed skill exceeds {MAX_MANAGED_TREE_BYTES} bytes"
            )));
        }
        if paths.len() >= MAX_MANAGED_TREE_FILES {
            return Err(AppError::InvalidInput(format!(
                "managed skill exceeds {MAX_MANAGED_TREE_FILES} files"
            )));
        }
        paths.push(
            entry
                .path()
                .strip_prefix(root)
                .map_err(|_| AppError::Internal("managed tree path escaped its root".to_owned()))?
                .to_path_buf(),
        );
    }

    paths.sort();
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    for relative in paths {
        let portable = relative.to_string_lossy().replace('\\', "/");
        digest.update(portable.as_bytes());
        digest.update([0]);

        let mut file = fs::File::open(root.join(&relative))?;
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            digest.update(&buffer[..read]);
        }
        digest.update([0xff]);
    }
    Ok(hex::encode(digest.finalize()))
}

fn load_codex_enabled_overrides(codex_home: &Path) -> AppResult<HashMap<String, bool>> {
    let config_path = codex_home.join("config.toml");
    let content = match fs::read_to_string(&config_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(error) => return Err(error.into()),
    };
    if content.trim().is_empty() {
        return Ok(HashMap::new());
    }
    let document = match content.parse::<DocumentMut>() {
        Ok(document) => document,
        // Inventory discovery is read-only and must remain available even if
        // another tool left config.toml half-written. Ignore only the toggle
        // overrides; mutation commands still surface malformed configuration.
        Err(_) => return Ok(HashMap::new()),
    };
    let Some(entries) = document
        .get("skills")
        .and_then(Item::as_table)
        .and_then(|skills| skills.get("config"))
        .and_then(Item::as_array_of_tables)
    else {
        return Ok(HashMap::new());
    };

    let mut overrides = HashMap::new();
    for entry in entries.iter() {
        let Some(path) = entry.get("path").and_then(Item::as_str) else {
            continue;
        };
        let Some(enabled) = entry.get("enabled").and_then(Item::as_bool) else {
            continue;
        };
        let key = configured_skill_path_key(path, codex_home);
        // The writer appends when an existing path differs only by Windows
        // spelling. Let the newest entry win so a user toggle is not masked by
        // an older equivalent path.
        overrides.insert(key, enabled);
    }
    Ok(overrides)
}

fn configured_skill_path_key(configured: &str, codex_home: &Path) -> String {
    let configured = PathBuf::from(configured);
    let mut path = if configured.is_absolute() {
        configured
    } else {
        codex_home.join(configured)
    };
    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            if cfg!(target_os = "windows") {
                name.eq_ignore_ascii_case(MANIFEST_FILE_NAME)
            } else {
                name == MANIFEST_FILE_NAME
            }
        })
    {
        path.pop();
    }
    path_comparison_key(&path)
}

fn apply_enabled_state(skill: &mut ScannedSkill, overrides: &HashMap<String, bool>) {
    if skill.agent_type != "codex" || skill.scope_kind == "plugin" {
        skill.enabled_state = "unknown".to_owned();
        return;
    }

    let enabled = overrides
        .get(&path_comparison_key(Path::new(&skill.skill_path)))
        .copied()
        .unwrap_or(true);
    skill.enabled_state = if enabled { "enabled" } else { "disabled" }.to_owned();
}

pub fn get_skill(database: &Database, id: &str) -> AppResult<SkillDetail> {
    let mut stored = load_stored_skill(database, id)?;
    skill_descriptions::apply_description_overlays(
        database,
        std::slice::from_mut(&mut stored.summary),
    )?;
    let (files, truncated) = list_skill_files(&stored.skill_path)?;

    let mut metadata = stored.metadata;
    if let Some(object) = metadata.as_object_mut() {
        object.insert("fileListTruncated".to_owned(), Value::Bool(truncated));
    }

    let stored_frontmatter = metadata
        .get("frontmatter")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let frontmatter = match read_file_beneath(
        &stored.skill_path,
        Path::new(MANIFEST_FILE_NAME),
        MAX_MANIFEST_BYTES,
    ) {
        Ok(content) => parse_frontmatter(&content).value,
        Err(_) => stored_frontmatter,
    };

    Ok(SkillDetail {
        summary: stored.summary,
        files,
        frontmatter,
        metadata,
    })
}

pub fn read_skill_file(database: &Database, id: &str, relative_path: &str) -> AppResult<String> {
    let relative_path = validate_relative_path(relative_path)?;
    let stored = load_stored_skill(database, id)?;
    read_file_beneath(&stored.skill_path, &relative_path, MAX_READ_FILE_BYTES)
}

fn load_projects(database: &Database, project_ids: &[String]) -> AppResult<Vec<ProjectRoot>> {
    database.with_connection(|connection| {
        if project_ids.is_empty() {
            let mut statement =
                connection.prepare("SELECT id, root_path FROM projects ORDER BY id")?;
            let rows = statement.query_map([], |row| {
                Ok(ProjectRoot {
                    id: row.get(0)?,
                    root: PathBuf::from(row.get::<_, String>(1)?),
                })
            })?;
            return rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from);
        }

        let mut projects = Vec::with_capacity(project_ids.len());
        for id in project_ids {
            let project = connection
                .query_row(
                    "SELECT id, root_path FROM projects WHERE id = ?1",
                    [id],
                    |row| {
                        Ok(ProjectRoot {
                            id: row.get(0)?,
                            root: PathBuf::from(row.get::<_, String>(1)?),
                        })
                    },
                )
                .optional()?;
            match project {
                Some(project) => projects.push(project),
                None => return Err(AppError::NotFound(format!("project {id}"))),
            }
        }
        Ok(projects)
    })
}

fn build_skill_roots(
    home: &Path,
    codex_home: &Path,
    projects: &[ProjectRoot],
    include_plugin_cache: bool,
) -> Vec<SkillRoot> {
    let mut roots = vec![
        SkillRoot {
            agent_type: "codex",
            scope_kind: "user",
            source_kind: "filesystem",
            root: home.join(".agents").join("skills"),
            project_id: None,
            read_only: false,
            discovery_mode: DiscoveryMode::DirectChildren,
            excluded_children: &[],
        },
        SkillRoot {
            agent_type: "codex",
            scope_kind: "user",
            source_kind: "filesystem",
            root: codex_home.join("skills"),
            project_id: None,
            read_only: false,
            discovery_mode: DiscoveryMode::DirectChildren,
            excluded_children: &[".system"],
        },
        SkillRoot {
            agent_type: "claude",
            scope_kind: "user",
            source_kind: "filesystem",
            root: home.join(".claude").join("skills"),
            project_id: None,
            read_only: false,
            discovery_mode: DiscoveryMode::DirectChildren,
            excluded_children: &[],
        },
        SkillRoot {
            agent_type: "cursor",
            scope_kind: "user",
            source_kind: "filesystem",
            root: home.join(".cursor").join("skills"),
            project_id: None,
            read_only: false,
            discovery_mode: DiscoveryMode::DirectChildren,
            excluded_children: &[],
        },
        SkillRoot {
            agent_type: "cursor",
            scope_kind: "user",
            source_kind: "filesystem",
            root: home.join(".agents").join("skills"),
            project_id: None,
            read_only: false,
            discovery_mode: DiscoveryMode::DirectChildren,
            excluded_children: &[],
        },
        SkillRoot {
            agent_type: "codex",
            scope_kind: "system",
            source_kind: "system",
            root: codex_home.join("skills").join(".system"),
            project_id: None,
            read_only: true,
            discovery_mode: DiscoveryMode::DirectChildren,
            excluded_children: &[],
        },
    ];

    if include_plugin_cache {
        roots.push(SkillRoot {
            agent_type: "codex",
            scope_kind: "plugin",
            source_kind: "plugin",
            root: codex_home.join("plugins").join("cache"),
            project_id: None,
            read_only: true,
            discovery_mode: DiscoveryMode::DescendantManifests,
            excluded_children: &[],
        });
    }

    for project in projects {
        let project_id = Some(project.id.clone());
        roots.extend([
            SkillRoot {
                agent_type: "codex",
                scope_kind: "repo",
                source_kind: "filesystem",
                root: project.root.join(".agents").join("skills"),
                project_id: project_id.clone(),
                read_only: false,
                discovery_mode: DiscoveryMode::DirectChildren,
                excluded_children: &[],
            },
            SkillRoot {
                agent_type: "codex",
                scope_kind: "repo",
                source_kind: "filesystem",
                root: project.root.join(".codex").join("skills"),
                project_id: project_id.clone(),
                read_only: false,
                discovery_mode: DiscoveryMode::DirectChildren,
                excluded_children: &[".system"],
            },
            SkillRoot {
                agent_type: "claude",
                scope_kind: "repo",
                source_kind: "filesystem",
                root: project.root.join(".claude").join("skills"),
                project_id: project_id.clone(),
                read_only: false,
                discovery_mode: DiscoveryMode::DirectChildren,
                excluded_children: &[],
            },
            SkillRoot {
                agent_type: "cursor",
                scope_kind: "repo",
                source_kind: "filesystem",
                root: project.root.join(".cursor").join("skills"),
                project_id: project_id.clone(),
                read_only: false,
                discovery_mode: DiscoveryMode::DirectChildren,
                excluded_children: &[],
            },
            SkillRoot {
                agent_type: "cursor",
                scope_kind: "repo",
                source_kind: "filesystem",
                root: project.root.join(".agents").join("skills"),
                project_id: project_id.clone(),
                read_only: false,
                discovery_mode: DiscoveryMode::DirectChildren,
                excluded_children: &[],
            },
        ]);
    }

    roots
}

fn discover_candidates(root: &SkillRoot) -> RootDiscovery {
    match fs::metadata(&root.root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return RootDiscovery {
                candidates: Vec::new(),
                complete: true,
            };
        }
        Err(_) => {
            return RootDiscovery {
                candidates: Vec::new(),
                complete: false,
            };
        }
        Ok(metadata) if !metadata.is_dir() => {
            return RootDiscovery {
                candidates: Vec::new(),
                complete: false,
            };
        }
        Ok(_) => {}
    }

    let mut complete = true;
    let mut candidates = Vec::new();
    match root.discovery_mode {
        DiscoveryMode::DirectChildren => {
            let entries = match fs::read_dir(&root.root) {
                Ok(entries) => entries,
                Err(_) => {
                    return RootDiscovery {
                        candidates,
                        complete: false,
                    };
                }
            };
            for entry in entries {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(_) => {
                        complete = false;
                        continue;
                    }
                };
                let name = entry.file_name();
                if root
                    .excluded_children
                    .iter()
                    .any(|excluded| name.as_os_str() == std::ffi::OsStr::new(excluded))
                {
                    continue;
                }
                let path = entry.path();
                let metadata = match fs::symlink_metadata(&path) {
                    Ok(metadata) => metadata,
                    Err(_) => {
                        complete = false;
                        continue;
                    }
                };
                if metadata.is_dir()
                    || metadata.file_type().is_symlink()
                    || is_windows_junction(&metadata)
                {
                    candidates.push(path);
                }
            }
        }
        DiscoveryMode::DescendantManifests => {
            for entry in WalkDir::new(&root.root)
                .follow_links(false)
                .max_depth(MAX_PLUGIN_CACHE_DEPTH)
            {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(_) => {
                        complete = false;
                        continue;
                    }
                };
                if entry.file_type().is_file()
                    && entry.file_name() == std::ffi::OsStr::new(MANIFEST_FILE_NAME)
                {
                    if let Some(parent) = entry.path().parent() {
                        candidates.push(parent.to_path_buf());
                    }
                }
            }
        }
    }
    candidates.sort();
    candidates.dedup();
    RootDiscovery {
        candidates,
        complete,
    }
}

fn inspect_candidate(root: &SkillRoot, skill_path: &Path, last_seen_at: i64) -> ScannedSkill {
    let location_path = absolute_path(skill_path);
    let canonical_path = location_path.to_string_lossy().into_owned();
    let skill_path_string = location_path.to_string_lossy().into_owned();
    let location_id = stable_id("location", root.agent_type, &canonical_path);
    let skill_id = stable_id("skill", root.agent_type, &canonical_path);
    let link_kind = link_kind(skill_path).to_owned();
    let fallback_name = skill_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("unnamed-skill")
        .to_owned();

    let mut name = fallback_name.clone();
    let mut display_name = fallback_name.clone();
    let mut description = String::new();
    let health_status;
    let mut observed_hash = None;
    let mut frontmatter = json!({});
    let mut parse_error = None;
    let mut resolved_path = None;

    match fs::canonicalize(skill_path) {
        Err(error) => {
            health_status = if link_kind == "symlink" || link_kind == "junction" {
                "broken_link".to_owned()
            } else {
                "unreadable".to_owned()
            };
            parse_error = Some(error.to_string());
        }
        Ok(resolved_root) => {
            resolved_path = Some(resolved_root.to_string_lossy().into_owned());
            if !resolved_root.is_dir() {
                health_status = "not_directory".to_owned();
            } else {
                match read_file_beneath(
                    &resolved_root,
                    Path::new(MANIFEST_FILE_NAME),
                    MAX_MANIFEST_BYTES,
                ) {
                    Ok(contents) => {
                        observed_hash = Some(sha256_hex(contents.as_bytes()));
                        let indexed = index_skill_manifest(&contents, &fallback_name, &link_kind);
                        name = indexed.name;
                        display_name = indexed.display_name;
                        description = indexed.description;
                        frontmatter = indexed.frontmatter;
                        health_status = indexed.health_status;
                        parse_error = indexed.parse_error;
                    }
                    Err(error) => {
                        health_status = match &error {
                            AppError::NotFound(_) => "missing_manifest",
                            AppError::InvalidInput(_) => "invalid_manifest",
                            _ => "unreadable",
                        }
                        .to_owned();
                        parse_error = Some(error.to_string());
                    }
                }
            }
        }
    }

    let read_only = root.read_only
        || fs::metadata(skill_path)
            .map(|metadata| metadata.permissions().readonly())
            .unwrap_or(false);
    let metadata = json!({
        "frontmatter": frontmatter,
        "rootPath": root.root.to_string_lossy(),
        "manifestPath": location_path.join(MANIFEST_FILE_NAME).to_string_lossy(),
        "resolvedPath": resolved_path,
        "parseError": parse_error,
        "discoverySource": root.source_kind,
        "linkKind": link_kind.clone(),
        "cacheStatus": if root.scope_kind == "plugin" { Value::String("unknown".to_owned()) } else { Value::Null },
    });

    ScannedSkill {
        location_id,
        skill_id,
        name,
        display_name,
        description,
        agent_type: root.agent_type.to_owned(),
        scope_kind: root.scope_kind.to_owned(),
        source_kind: root.source_kind.to_owned(),
        skill_path: skill_path_string,
        canonical_path,
        enabled_state: "unknown".to_owned(),
        read_only,
        managed: false,
        health_status,
        project_id: root.project_id.clone(),
        link_kind,
        observed_hash,
        metadata,
        last_seen_at,
    }
}

fn persist_scan(
    database: &Database,
    skills: &[ScannedSkill],
    completed_roots: &[SkillRoot],
    scan_token: i64,
) -> AppResult<()> {
    database.with_connection(|connection| {
        let transaction = connection.unchecked_transaction()?;

        for skill in skills {
            if !skill.managed {
                transaction.execute(
                    "INSERT INTO skills(
                        id, logical_name, display_name, description, source_kind, source_uri,
                        managed, active_revision_id, created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, NULL, ?7, ?7)
                     ON CONFLICT(id) DO UPDATE SET
                        logical_name=excluded.logical_name,
                        display_name=excluded.display_name,
                        description=excluded.description,
                        source_kind=excluded.source_kind,
                        source_uri=excluded.source_uri,
                        updated_at=excluded.updated_at",
                    params![
                        skill.skill_id,
                        skill.name,
                        skill.display_name,
                        skill.description,
                        skill.source_kind,
                        skill.skill_path,
                        scan_token,
                    ],
                )?;
            }
            transaction.execute(
                "INSERT INTO skill_locations(
                    id, skill_id, agent_type, scope_kind, project_id, skill_path,
                    canonical_path, enabled_state, read_only, link_kind, health_status,
                    observed_hash, last_seen_at, metadata_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                 ON CONFLICT(id) DO UPDATE SET
                    skill_id=excluded.skill_id,
                    agent_type=excluded.agent_type,
                    scope_kind=excluded.scope_kind,
                    project_id=excluded.project_id,
                    skill_path=excluded.skill_path,
                    canonical_path=excluded.canonical_path,
                    enabled_state=excluded.enabled_state,
                    read_only=excluded.read_only,
                    link_kind=excluded.link_kind,
                    health_status=excluded.health_status,
                    observed_hash=excluded.observed_hash,
                    last_seen_at=excluded.last_seen_at,
                    metadata_json=excluded.metadata_json",
                params![
                    skill.location_id,
                    skill.skill_id,
                    skill.agent_type,
                    skill.scope_kind,
                    skill.project_id,
                    skill.skill_path,
                    skill.canonical_path,
                    skill.enabled_state,
                    skill.read_only as i64,
                    skill.link_kind,
                    skill.health_status,
                    skill.observed_hash,
                    skill.last_seen_at,
                    skill.metadata.to_string(),
                ],
            )?;
        }

        let discovered_ids = skills
            .iter()
            .map(|skill| skill.location_id.as_str())
            .collect::<HashSet<_>>();
        let existing = {
            let mut statement = transaction.prepare(
                "SELECT id, agent_type, scope_kind, project_id, skill_path FROM skill_locations",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for (id, agent_type, scope_kind, project_id, skill_path) in existing {
            let was_completely_scanned = completed_roots.iter().any(|root| {
                root_covers_location(
                    root,
                    &agent_type,
                    &scope_kind,
                    project_id.as_deref(),
                    Path::new(&skill_path),
                )
            });
            if was_completely_scanned && !discovered_ids.contains(id.as_str()) {
                transaction.execute("DELETE FROM skill_locations WHERE id = ?1", [&id])?;
            }
        }

        // Only discard a derived logical row when no managed history depends
        // on it. This avoids deleting future revisions during reconciliation.
        transaction.execute(
            "DELETE FROM skills
             WHERE managed = 0
               AND active_revision_id IS NULL
               AND NOT EXISTS (SELECT 1 FROM skill_locations l WHERE l.skill_id = skills.id)
               AND NOT EXISTS (SELECT 1 FROM skill_revisions r WHERE r.skill_id = skills.id)",
            [],
        )?;
        transaction.commit()?;
        Ok(())
    })
}

fn root_covers_location(
    root: &SkillRoot,
    agent_type: &str,
    scope_kind: &str,
    project_id: Option<&str>,
    skill_path: &Path,
) -> bool {
    if root.agent_type != agent_type
        || root.scope_kind != scope_kind
        || root.project_id.as_deref() != project_id
    {
        return false;
    }

    match root.discovery_mode {
        DiscoveryMode::DirectChildren => skill_path
            .parent()
            .is_some_and(|parent| path_comparison_key(parent) == path_comparison_key(&root.root)),
        DiscoveryMode::DescendantManifests => {
            let root_key = path_comparison_key(&root.root);
            let skill_key = path_comparison_key(skill_path);
            if skill_key == root_key {
                return true;
            }
            let prefix = if root_key.ends_with('/') {
                root_key
            } else {
                format!("{root_key}/")
            };
            skill_key.starts_with(&prefix)
        }
    }
}

fn to_summaries(skills: &[ScannedSkill]) -> Vec<SkillSummary> {
    let mut counts = HashMap::<(String, String), usize>::new();
    for skill in skills {
        *counts
            .entry((skill.agent_type.clone(), normalize_name(&skill.name)))
            .or_default() += 1;
    }

    let mut summaries = skills
        .iter()
        .map(|skill| SkillSummary {
            id: skill.location_id.clone(),
            name: skill.name.clone(),
            display_name: skill.display_name.clone(),
            description: skill.description.clone(),
            agent_type: skill.agent_type.clone(),
            scope_kind: skill.scope_kind.clone(),
            source_kind: skill.source_kind.clone(),
            path: skill.skill_path.clone(),
            enabled_state: skill.enabled_state.clone(),
            read_only: skill.read_only,
            managed: skill.managed,
            health_status: skill.health_status.clone(),
            risk_status: "unscanned".to_owned(),
            project_id: skill.project_id.clone(),
            duplicate_name: counts
                .get(&(skill.agent_type.clone(), normalize_name(&skill.name)))
                .copied()
                .unwrap_or_default()
                > 1,
            updated_at: skill.last_seen_at,
            description_localization: None,
            description_localizations: Vec::new(),
        })
        .collect::<Vec<_>>();
    summaries.sort_by(|left, right| {
        left.agent_type
            .cmp(&right.agent_type)
            .then_with(|| normalize_name(&left.name).cmp(&normalize_name(&right.name)))
            .then_with(|| left.scope_kind.cmp(&right.scope_kind))
            .then_with(|| left.path.cmp(&right.path))
    });
    summaries
}

fn load_stored_skill(database: &Database, id: &str) -> AppResult<StoredSkill> {
    database.with_connection(|connection| {
        let row = connection
            .query_row(
                "SELECT
                    l.id, s.logical_name, s.display_name, s.description,
                    l.agent_type, l.scope_kind, s.source_kind, l.skill_path,
                    l.enabled_state, l.read_only, s.managed, l.health_status,
                    l.project_id, l.last_seen_at, l.metadata_json
                 FROM skill_locations l
                 JOIN skills s ON s.id = l.skill_id
                 WHERE l.id = ?1 OR s.id = ?1
                 ORDER BY CASE WHEN l.id = ?1 THEN 0 ELSE 1 END, l.id
                 LIMIT 1",
                [id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, i64>(9)? != 0,
                        row.get::<_, i64>(10)? != 0,
                        row.get::<_, String>(11)?,
                        row.get::<_, Option<String>>(12)?,
                        row.get::<_, i64>(13)?,
                        row.get::<_, String>(14)?,
                    ))
                },
            )
            .optional()?;
        let Some((
            location_id,
            name,
            display_name,
            description,
            agent_type,
            scope_kind,
            source_kind,
            skill_path,
            enabled_state,
            read_only,
            managed,
            health_status,
            project_id,
            updated_at,
            metadata_json,
        )) = row
        else {
            return Err(AppError::NotFound(format!("skill {id}")));
        };

        let duplicate_name = has_duplicate_name(connection, &location_id, &agent_type, &name)?;
        let risk_status = location_risk_status(connection, &location_id)?;
        let metadata = serde_json::from_str(&metadata_json).unwrap_or_else(|_| json!({}));
        Ok(StoredSkill {
            summary: SkillSummary {
                id: location_id,
                name,
                display_name,
                description,
                agent_type,
                scope_kind,
                source_kind,
                path: skill_path.clone(),
                enabled_state,
                read_only,
                managed,
                health_status,
                risk_status,
                project_id,
                duplicate_name,
                updated_at,
                description_localization: None,
                description_localizations: Vec::new(),
            },
            skill_path: PathBuf::from(skill_path),
            metadata,
        })
    })
}

fn has_duplicate_name(
    connection: &rusqlite::Connection,
    location_id: &str,
    agent_type: &str,
    name: &str,
) -> AppResult<bool> {
    let mut statement = connection.prepare(
        "SELECT l.id, s.logical_name
         FROM skill_locations l
         JOIN skills s ON s.id = l.skill_id
         WHERE l.agent_type = ?1 AND l.id <> ?2",
    )?;
    let rows = statement.query_map(params![agent_type, location_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let expected = normalize_name(name);
    for row in rows {
        let (_, candidate) = row?;
        if normalize_name(&candidate) == expected {
            return Ok(true);
        }
    }
    Ok(false)
}

fn location_risk_status(connection: &rusqlite::Connection, location_id: &str) -> AppResult<String> {
    let status = connection
        .query_row(
            "SELECT status FROM skill_security_scans WHERE location_id = ?1",
            [location_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    Ok(match status.as_deref() {
        Some(valid @ ("safe" | "review" | "risky" | "blocked")) => valid.to_owned(),
        _ => "unscanned".to_owned(),
    })
}

fn list_skill_files(root: &Path) -> AppResult<(Vec<SkillFile>, bool)> {
    let canonical_root = match fs::canonicalize(root) {
        Ok(root) if root.is_dir() => root,
        Ok(_) => return Ok((Vec::new(), false)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((Vec::new(), false));
        }
        Err(error) => return Err(error.into()),
    };

    let mut files = Vec::new();
    let mut truncated = false;
    for entry in WalkDir::new(&canonical_root)
        .follow_links(false)
        .into_iter()
    {
        let Ok(entry) = entry else {
            continue;
        };
        if entry.depth() == 0 {
            continue;
        }
        if files.len() == MAX_SKILL_ENTRIES {
            truncated = true;
            break;
        }
        let Ok(relative) = entry.path().strip_prefix(&canonical_root) else {
            continue;
        };
        let metadata = match fs::symlink_metadata(entry.path()) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        let target_metadata = if metadata.file_type().is_symlink() {
            fs::metadata(entry.path()).ok()
        } else {
            None
        };
        if metadata.is_dir() || target_metadata.as_ref().is_some_and(fs::Metadata::is_dir) {
            continue;
        }
        let size = target_metadata
            .as_ref()
            .filter(|metadata| metadata.is_file())
            .map(fs::Metadata::len)
            .unwrap_or_else(|| {
                if metadata.is_file() {
                    metadata.len()
                } else {
                    0
                }
            });
        files.push(SkillFile {
            path: portable_relative_path(relative),
            size,
            kind: skill_file_kind(entry.path()),
        });
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok((files, truncated))
}

fn validate_relative_path(value: &str) -> AppResult<PathBuf> {
    if value.is_empty() || value.contains('\0') {
        return Err(AppError::InvalidInput(
            "skill file path must be a non-empty relative path".to_owned(),
        ));
    }
    let path = Path::new(value);
    if path.is_absolute() {
        return Err(AppError::InvalidInput(
            "absolute skill file paths are not allowed".to_owned(),
        ));
    }
    for component in path.components() {
        match component {
            Component::Normal(part) =>
            {
                #[cfg(target_os = "windows")]
                if part.to_string_lossy().contains(':') {
                    return Err(AppError::InvalidInput(
                        "Windows alternate data stream paths are not allowed".to_owned(),
                    ));
                }
            }
            _ => {
                return Err(AppError::InvalidInput(
                    "skill file path cannot contain root, prefix, dot, or parent components"
                        .to_owned(),
                ));
            }
        }
    }
    Ok(path.to_path_buf())
}

fn read_file_beneath(root: &Path, relative_path: &Path, max_bytes: u64) -> AppResult<String> {
    if relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(AppError::InvalidInput(
            "skill file path escapes the skill directory".to_owned(),
        ));
    }

    let canonical_root = fs::canonicalize(root).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::NotFound(format!("skill directory {}", root.display()))
        } else {
            AppError::Io(error)
        }
    })?;
    if !canonical_root.is_dir() {
        return Err(AppError::InvalidInput(
            "skill root is not a directory".to_owned(),
        ));
    }

    let requested = canonical_root.join(relative_path);
    let canonical_file = fs::canonicalize(&requested).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::NotFound(format!("skill file {}", relative_path.display()))
        } else {
            AppError::Io(error)
        }
    })?;
    if !canonical_file.starts_with(&canonical_root) {
        return Err(AppError::InvalidInput(
            "skill file path resolves outside the skill directory".to_owned(),
        ));
    }
    let metadata = fs::metadata(&canonical_file)?;
    if !metadata.is_file() {
        return Err(AppError::InvalidInput(
            "requested skill entry is not a regular file".to_owned(),
        ));
    }
    if metadata.len() > max_bytes {
        return Err(AppError::InvalidInput(format!(
            "skill file is larger than the {max_bytes} byte inspection limit"
        )));
    }
    let bytes = fs::read(canonical_file)?;
    String::from_utf8(bytes)
        .map_err(|_| AppError::InvalidInput("skill file is not valid UTF-8 text".to_owned()))
}

pub(crate) fn parse_frontmatter(content: &str) -> ParsedFrontmatter {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let lines = content.lines().collect::<Vec<_>>();
    if lines.first().map(|line| line.trim_end_matches('\r').trim()) != Some("---") {
        return ParsedFrontmatter {
            value: json!({}),
            error: Some("SKILL.md must start with YAML frontmatter".to_owned()),
            ..ParsedFrontmatter::default()
        };
    }

    let Some(end) =
        lines.iter().enumerate().skip(1).find_map(|(index, line)| {
            (line.trim_end_matches('\r').trim() == "---").then_some(index)
        })
    else {
        return ParsedFrontmatter {
            value: json!({}),
            error: Some("SKILL.md frontmatter is missing its closing delimiter".to_owned()),
            ..ParsedFrontmatter::default()
        };
    };

    let mut map = Map::new();
    let body = &lines[1..end];
    let mut index = 0;
    while index < body.len() {
        let raw = body[index].trim_end_matches('\r');
        if raw.trim().is_empty() || raw.trim_start().starts_with('#') || starts_indented(raw) {
            index += 1;
            continue;
        }
        let Some((key, raw_value)) = raw.split_once(':') else {
            index += 1;
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            index += 1;
            continue;
        }
        let value = raw_value.trim();
        if value.starts_with('|') || value.starts_with('>') {
            let folded = value.starts_with('>');
            index += 1;
            let start = index;
            while index < body.len() {
                let line = body[index].trim_end_matches('\r');
                if !line.trim().is_empty() && !starts_indented(line) {
                    break;
                }
                index += 1;
            }
            let block = parse_block_scalar(&body[start..index], folded);
            map.insert(key.to_owned(), Value::String(block));
            continue;
        }
        map.insert(key.to_owned(), parse_scalar(value));
        index += 1;
    }

    let name = map
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let description = map
        .get("description")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let display_name = map
        .get("display-name")
        .or_else(|| map.get("display_name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let error = match (&name, &description) {
        (None, None) => {
            Some("frontmatter requires non-empty name and description fields".to_owned())
        }
        (None, _) => Some("frontmatter requires a non-empty name field".to_owned()),
        (_, None) => Some("frontmatter requires a non-empty description field".to_owned()),
        _ => None,
    };

    ParsedFrontmatter {
        value: Value::Object(map),
        name,
        description,
        display_name,
        error,
    }
}

pub(crate) fn index_skill_manifest(
    content: &str,
    fallback_name: &str,
    link_kind: &str,
) -> IndexedSkillManifest {
    let parsed = parse_frontmatter(content);
    let name = parsed
        .name
        .clone()
        .unwrap_or_else(|| fallback_name.to_owned());
    let display_name = parsed.display_name.clone().unwrap_or_else(|| name.clone());
    let description = parsed.description.clone().unwrap_or_default();
    let health_status = if parsed.error.is_some() {
        "invalid_frontmatter"
    } else if link_kind == "directory" && normalize_name(&name) != normalize_name(fallback_name) {
        "name_mismatch"
    } else {
        "ok"
    }
    .to_owned();
    IndexedSkillManifest {
        name,
        display_name,
        description,
        frontmatter: parsed.value,
        health_status,
        parse_error: parsed.error,
    }
}

pub(crate) fn skill_identity_from_manifest(content: &str) -> (Option<String>, Option<String>) {
    let parsed = parse_frontmatter(content);
    (parsed.name, parsed.description)
}

fn starts_indented(value: &str) -> bool {
    value.starts_with(' ') || value.starts_with('\t')
}

fn parse_block_scalar(lines: &[&str], folded: bool) -> String {
    let minimum_indent = lines
        .iter()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            line.chars()
                .take_while(|character| character.is_whitespace())
                .count()
        })
        .min()
        .unwrap_or(0);
    let values = lines
        .iter()
        .map(|line| {
            if line.trim().is_empty() {
                String::new()
            } else {
                line.chars().skip(minimum_indent).collect::<String>()
            }
        })
        .collect::<Vec<_>>();
    if !folded {
        return values.join("\n").trim().to_owned();
    }

    let mut output = String::new();
    let mut previous_blank = false;
    for value in values {
        if value.is_empty() {
            if !output.ends_with('\n') {
                output.push('\n');
            }
            previous_blank = true;
            continue;
        }
        if !output.is_empty() && !output.ends_with('\n') {
            output.push(' ');
        } else if previous_blank && !output.is_empty() && !output.ends_with("\n\n") {
            output.push('\n');
        }
        output.push_str(&value);
        previous_blank = false;
    }
    output.trim().to_owned()
}

fn parse_scalar(value: &str) -> Value {
    let value = strip_inline_comment(value).trim();
    if value.len() >= 2 && value.starts_with('\'') && value.ends_with('\'') {
        return Value::String(value[1..value.len() - 1].replace("''", "'"));
    }
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        return serde_json::from_str(value)
            .unwrap_or_else(|_| Value::String(value[1..value.len() - 1].to_owned()));
    }
    match value.to_ascii_lowercase().as_str() {
        "true" => return Value::Bool(true),
        "false" => return Value::Bool(false),
        "null" | "~" => return Value::Null,
        _ => {}
    }
    if let Ok(integer) = value.parse::<i64>() {
        return Value::Number(integer.into());
    }
    if value.starts_with('[') || value.starts_with('{') {
        if let Ok(json_value) = serde_json::from_str(value) {
            return json_value;
        }
    }
    Value::String(value.to_owned())
}

fn strip_inline_comment(value: &str) -> &str {
    let mut quote = None;
    let mut escaped = false;
    for (index, character) in value.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && quote == Some('"') {
            escaped = true;
            continue;
        }
        if matches!(character, '\'' | '"') {
            if quote == Some(character) {
                quote = None;
            } else if quote.is_none() {
                quote = Some(character);
            }
            continue;
        }
        if character == '#'
            && quote.is_none()
            && value[..index]
                .chars()
                .next_back()
                .is_some_and(char::is_whitespace)
        {
            return &value[..index];
        }
    }
    value
}

fn link_kind(path: &Path) -> &'static str {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => "symlink",
        Ok(metadata) if is_windows_junction(&metadata) => "junction",
        _ => "directory",
    }
}

#[cfg(target_os = "windows")]
fn is_windows_junction(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        && !metadata.file_type().is_symlink()
}

#[cfg(not(target_os = "windows"))]
fn is_windows_junction(_metadata: &fs::Metadata) -> bool {
    false
}

fn stable_id(prefix: &str, agent_type: &str, canonical_path: &str) -> String {
    let digest = sha256_hex(format!("{agent_type}\0{canonical_path}").as_bytes());
    format!("{prefix}_{}", &digest[..32])
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn normalize_name(value: &str) -> String {
    value.nfkc().collect::<String>().to_lowercase()
}

fn path_comparison_key(path: &Path) -> String {
    let path = absolute_path(path);
    normalize_path_for_comparison(&path.to_string_lossy(), cfg!(target_os = "windows"))
}

fn normalize_path_for_comparison(value: &str, windows: bool) -> String {
    let mut value = if windows {
        value.replace('\\', "/")
    } else {
        value.to_owned()
    };

    if windows {
        let lowercase = value.to_ascii_lowercase();
        if lowercase.starts_with("//?/unc/") {
            value = format!("//{}", &value[8..]);
        } else if lowercase.starts_with("//?/") {
            value = value[4..].to_owned();
        }
    }

    let prefix = if value.starts_with("//") {
        "//"
    } else if value.starts_with('/') {
        "/"
    } else {
        ""
    };
    let mut components = Vec::<&str>::new();
    for component in value.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                let can_pop = components
                    .last()
                    .is_some_and(|previous| *previous != ".." && !previous.ends_with(':'));
                if can_pop {
                    components.pop();
                } else if prefix.is_empty() {
                    components.push(component);
                }
            }
            _ => components.push(component),
        }
    }
    let mut normalized = format!("{prefix}{}", components.join("/"));
    if windows {
        normalized = normalized.to_lowercase();
    }
    normalized
}

fn absolute_path(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|current| current.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    }
}

fn portable_relative_path(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn skill_file_kind(path: &Path) -> String {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "md" | "mdx" => "markdown",
        "yaml" | "yml" => "yaml",
        "json" => "json",
        "toml" => "toml",
        "ps1" | "psm1" => "powershell",
        "sh" | "bash" | "zsh" => "shell",
        "py" => "python",
        "js" | "jsx" | "ts" | "tsx" | "rs" => "code",
        "txt" => "text",
        _ => "file",
    }
    .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_skill(root: &Path, directory: &str, name: &str, description: &str) -> PathBuf {
        let skill = root.join(directory);
        fs::create_dir_all(&skill).unwrap();
        fs::write(
            skill.join(MANIFEST_FILE_NAME),
            format!("---\nname: \"{name}\"\ndescription: \"{description}\"\n---\n\n# {name}\n"),
        )
        .unwrap();
        skill
    }

    fn database(temp: &TempDir) -> Database {
        Database::open(&temp.path().join("app-data")).unwrap()
    }

    fn register_project(database: &Database, id: &str, root: &Path) {
        database
            .with_connection(|connection| {
                connection.execute(
                    "INSERT INTO projects(id, name, root_path, trusted, created_at, updated_at)
                     VALUES (?1, 'Fixture', ?2, 1, 1, 1)",
                    params![id, root.to_string_lossy()],
                )?;
                Ok(())
            })
            .unwrap();
    }

    #[allow(clippy::too_many_arguments)]
    fn register_managed_binding(
        database: &Database,
        suffix: &str,
        logical_name: &str,
        display_name: &str,
        link_path: &str,
        object_path: &Path,
        tree_hash: &str,
        link_mode: &str,
    ) {
        let skill_id = format!("managed-skill-{suffix}");
        let revision_id = format!("managed-revision-{suffix}");
        let binding_id = format!("managed-binding-{suffix}");
        database
            .with_connection(|connection| {
                let transaction = connection.unchecked_transaction()?;
                transaction.execute(
                    "INSERT INTO skills(
                        id, logical_name, display_name, description, source_kind, source_uri,
                        managed, active_revision_id, created_at, updated_at
                     ) VALUES (?1, ?2, ?3, 'Managed fixture', 'local-import', ?4, 1, ?5, 1, 1)",
                    params![
                        skill_id,
                        logical_name,
                        display_name,
                        object_path.to_string_lossy(),
                        revision_id
                    ],
                )?;
                transaction.execute(
                    "INSERT INTO skill_revisions(
                        id, skill_id, tree_hash, object_path, manifest_json, scan_status, created_at
                     ) VALUES (?1, ?2, ?3, ?4, '{}', 'review', 1)",
                    params![
                        revision_id,
                        skill_id,
                        tree_hash,
                        object_path.to_string_lossy()
                    ],
                )?;
                transaction.execute(
                    "INSERT INTO skill_bindings(
                        id, skill_id, revision_id, agent_type, scope_kind, target_root,
                        link_path, link_mode, health_status, created_at, updated_at
                     ) VALUES (?1, ?2, ?3, 'codex', 'user', ?4, ?5, ?6, 'ok', 1, 1)",
                    params![
                        binding_id,
                        skill_id,
                        revision_id,
                        Path::new(link_path).parent().unwrap().to_string_lossy(),
                        link_path,
                        link_mode
                    ],
                )?;
                transaction.commit()?;
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn parses_quoted_and_folded_frontmatter() {
        let parsed = parse_frontmatter(
            "---\nname: '中文-skill'\ndescription: >-\n  第一行\n  second line\ndisplay-name: \"可视化技能\"\nenabled: true\n---\nbody",
        );
        assert_eq!(parsed.name.as_deref(), Some("中文-skill"));
        assert_eq!(parsed.description.as_deref(), Some("第一行 second line"));
        assert_eq!(parsed.display_name.as_deref(), Some("可视化技能"));
        assert_eq!(parsed.value["enabled"], Value::Bool(true));
        assert!(parsed.error.is_none());
    }

    #[test]
    fn invalid_frontmatter_reports_missing_required_fields() {
        let parsed = parse_frontmatter("---\nname: only-name\n---\nbody");
        assert_eq!(parsed.name.as_deref(), Some("only-name"));
        assert!(parsed.description.is_none());
        assert!(parsed.error.unwrap().contains("description"));
    }

    #[test]
    fn managed_binding_reuses_logical_skill_and_is_read_only() {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let codex_home = home.join(".codex");
        let deployed = write_skill(
            &home.join(".agents/skills"),
            "managed-one",
            "managed-one",
            "Managed fixture",
        );
        let database = database(&temp);
        let stored_link_path = if cfg!(target_os = "windows") {
            deployed.to_string_lossy().replace('\\', "/").to_uppercase()
        } else {
            deployed.to_string_lossy().into_owned()
        };
        let tree_hash = hash_managed_tree(&deployed).unwrap();
        register_managed_binding(
            &database,
            "valid",
            "managed-one",
            "Managed One",
            &stored_link_path,
            &deployed,
            &tree_hash,
            "junction",
        );

        let summaries = scan_skills_from(
            &database,
            &SkillScanRequest {
                project_ids: Vec::new(),
                include_plugin_cache: false,
            },
            &home,
            &codex_home,
        )
        .unwrap();
        let managed = summaries
            .iter()
            .find(|skill| skill.agent_type == "codex" && skill.name == "managed-one")
            .unwrap();
        assert!(managed.managed);
        assert!(managed.read_only);
        assert_eq!(managed.health_status, "ok");
        assert_eq!(managed.display_name, "Managed One");
        assert_eq!(managed.source_kind, "local-import");

        database
            .with_connection(|connection| {
                let linked_skill: String = connection.query_row(
                    "SELECT skill_id FROM skill_locations WHERE id = ?1",
                    [&managed.id],
                    |row| row.get(0),
                )?;
                let logical_count: i64 =
                    connection.query_row("SELECT COUNT(*) FROM skills", [], |row| row.get(0))?;
                assert_eq!(linked_skill, "managed-skill-valid");
                assert_eq!(logical_count, 1);
                Ok(())
            })
            .unwrap();
        let detail = get_skill(&database, &managed.id).unwrap();
        assert!(detail.summary.managed);
        assert!(detail.summary.read_only);
        assert_eq!(detail.metadata["managedBindingId"], "managed-binding-valid");
        assert_eq!(detail.metadata["managedValidationStatus"], "ok");
    }

    #[test]
    fn managed_binding_reports_target_mismatch_and_modified_tree() {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let codex_home = home.join(".codex");
        let user_skills = home.join(".agents/skills");
        let mismatch = write_skill(
            &user_skills,
            "target-mismatch",
            "target-mismatch",
            "Managed fixture",
        );
        let expected = write_skill(
            &temp.path().join("objects"),
            "expected",
            "target-mismatch",
            "Managed fixture",
        );
        let modified = write_skill(
            &user_skills,
            "modified-tree",
            "modified-tree",
            "Managed fixture",
        );
        let copied = write_skill(
            &user_skills,
            "copy-deployment",
            "copy-deployment",
            "Managed fixture",
        );
        let copy_object = write_skill(
            &temp.path().join("objects"),
            "copy-object",
            "copy-deployment",
            "Managed fixture",
        );
        let database = database(&temp);

        register_managed_binding(
            &database,
            "mismatch",
            "target-mismatch",
            "target-mismatch",
            &mismatch.to_string_lossy(),
            &expected,
            &hash_managed_tree(&expected).unwrap(),
            "junction",
        );
        let original_hash = hash_managed_tree(&modified).unwrap();
        fs::write(modified.join("unexpected.txt"), "changed after import").unwrap();
        register_managed_binding(
            &database,
            "modified",
            "modified-tree",
            "modified-tree",
            &modified.to_string_lossy(),
            &modified,
            &original_hash,
            "junction",
        );
        register_managed_binding(
            &database,
            "copy",
            "copy-deployment",
            "copy-deployment",
            &copied.to_string_lossy(),
            &copy_object,
            &hash_managed_tree(&copy_object).unwrap(),
            "copy",
        );

        let summaries = scan_skills_from(
            &database,
            &SkillScanRequest {
                project_ids: Vec::new(),
                include_plugin_cache: false,
            },
            &home,
            &codex_home,
        )
        .unwrap();
        let mismatch_summary = summaries
            .iter()
            .find(|skill| skill.agent_type == "codex" && skill.name == "target-mismatch")
            .unwrap();
        assert_eq!(mismatch_summary.health_status, "target_mismatch");
        assert!(mismatch_summary.read_only);
        let modified_summary = summaries
            .iter()
            .find(|skill| skill.agent_type == "codex" && skill.name == "modified-tree")
            .unwrap();
        assert_eq!(modified_summary.health_status, "modified");
        assert!(modified_summary.read_only);
        let copy_summary = summaries
            .iter()
            .find(|skill| skill.agent_type == "codex" && skill.name == "copy-deployment")
            .unwrap();
        assert_eq!(copy_summary.health_status, "ok");
        assert!(copy_summary.read_only);
    }

    #[test]
    fn codex_config_overrides_defaults_and_survives_rescan() {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let codex_home = home.join(".codex");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let toggle = write_skill(
            &home.join(".agents/skills"),
            "toggle-me",
            "toggle-me",
            "Toggle fixture",
        );
        write_skill(
            &project.join(".agents/skills"),
            "repo-default",
            "repo-default",
            "Repo default",
        );
        write_skill(
            &codex_home.join("skills/.system"),
            "system-default",
            "system-default",
            "System default",
        );
        write_skill(
            &codex_home.join("plugins/cache/vendor/plugin/1/skills"),
            "cached",
            "cached",
            "Plugin cache",
        );
        write_skill(
            &home.join(".claude/skills"),
            "claude-unknown",
            "claude-unknown",
            "Claude state",
        );

        let database = database(&temp);
        register_project(&database, "project-1", &project);
        let request = SkillScanRequest {
            project_ids: vec!["project-1".to_owned()],
            include_plugin_cache: true,
        };
        let first = scan_skills_from(&database, &request, &home, &codex_home).unwrap();
        assert_eq!(
            first
                .iter()
                .find(|skill| skill.agent_type == "codex" && skill.name == "toggle-me")
                .unwrap()
                .enabled_state,
            "enabled"
        );
        assert!(first.iter().any(|skill| {
            skill.agent_type == "codex"
                && skill.name == "repo-default"
                && skill.enabled_state == "enabled"
        }));
        assert!(first.iter().any(|skill| {
            skill.scope_kind == "system"
                && skill.name == "system-default"
                && skill.enabled_state == "enabled"
        }));
        assert!(first.iter().any(|skill| {
            skill.scope_kind == "plugin"
                && skill.name == "cached"
                && skill.enabled_state == "unknown"
        }));
        assert!(first.iter().any(|skill| {
            skill.agent_type == "claude"
                && skill.name == "claude-unknown"
                && skill.enabled_state == "unknown"
        }));

        let manifest_path = toggle
            .join(MANIFEST_FILE_NAME)
            .to_string_lossy()
            .into_owned();
        let encoded_path = serde_json::to_string(&manifest_path).unwrap();
        fs::write(
            codex_home.join("config.toml"),
            format!("[[skills.config]]\npath = {encoded_path}\nenabled = false\n"),
        )
        .unwrap();
        let location_id = first
            .iter()
            .find(|skill| skill.agent_type == "codex" && skill.name == "toggle-me")
            .unwrap()
            .id
            .clone();
        database
            .with_connection(|connection| {
                connection.execute(
                    "UPDATE skill_locations SET enabled_state = 'disabled' WHERE id = ?1",
                    [&location_id],
                )?;
                Ok(())
            })
            .unwrap();

        let rescanned = scan_skills_from(&database, &request, &home, &codex_home).unwrap();
        let toggled = rescanned
            .iter()
            .find(|skill| skill.agent_type == "codex" && skill.name == "toggle-me")
            .unwrap();
        assert_eq!(toggled.enabled_state, "disabled");
        assert_eq!(
            get_skill(&database, &toggled.id)
                .unwrap()
                .summary
                .enabled_state,
            "disabled"
        );
    }

    #[test]
    fn invalid_codex_config_does_not_abort_inventory_scan() {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let codex_home = home.join(".codex");
        write_skill(
            &home.join(".agents/skills"),
            "still-visible",
            "still-visible",
            "Visible despite malformed config",
        );
        fs::create_dir_all(&codex_home).unwrap();
        fs::write(codex_home.join("config.toml"), "[[skills.config]\n").unwrap();

        let database = database(&temp);
        let summaries = scan_skills_from(
            &database,
            &SkillScanRequest {
                project_ids: Vec::new(),
                include_plugin_cache: false,
            },
            &home,
            &codex_home,
        )
        .unwrap();
        let visible = summaries
            .iter()
            .find(|skill| skill.agent_type == "codex" && skill.name == "still-visible")
            .unwrap();
        assert_eq!(visible.enabled_state, "enabled");
    }

    #[test]
    fn windows_path_comparison_is_case_separator_and_prefix_stable() {
        let extended =
            normalize_path_for_comparison(r"\\?\C:\Users\ExampleUser\.agents\skills\Demo\", true);
        let ordinary =
            normalize_path_for_comparison("c:/users/exampleuser/.agents/skills/demo", true);
        assert_eq!(extended, ordinary);
        assert_eq!(
            normalize_path_for_comparison(r"\\?\UNC\Server\Share\Skill", true),
            normalize_path_for_comparison(r"\\server\share\skill\", true)
        );
    }

    #[test]
    fn scans_three_agents_projects_system_and_plugin_cache() {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let codex_home = home.join(".codex");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).unwrap();

        write_skill(
            &home.join(".agents/skills"),
            "shared",
            "shared",
            "Shared user skill",
        );
        write_skill(
            &home.join(".claude/skills"),
            "claude-one",
            "duplicate",
            "Claude user",
        );
        write_skill(
            &home.join(".cursor/skills"),
            "cursor-one",
            "cursor-one",
            "Cursor user",
        );
        write_skill(
            &codex_home.join("skills/.system"),
            "builtin",
            "builtin",
            "Codex built in",
        );
        write_skill(
            &codex_home.join("plugins/cache/vendor/plugin/1/skills"),
            "cached",
            "cached",
            "Cached plugin",
        );
        write_skill(
            &project.join(".agents/skills"),
            "repo-shared",
            "shared",
            "Shared repo skill",
        );
        write_skill(
            &project.join(".claude/skills"),
            "claude-repo",
            "duplicate",
            "Claude repo",
        );
        write_skill(
            &project.join(".cursor/skills"),
            "cursor-repo",
            "cursor-repo",
            "Cursor repo",
        );

        let database = database(&temp);
        register_project(&database, "project-1", &project);
        let summaries = scan_skills_from(
            &database,
            &SkillScanRequest {
                project_ids: vec!["project-1".to_owned()],
                include_plugin_cache: true,
            },
            &home,
            &codex_home,
        )
        .unwrap();

        assert!(summaries.iter().any(|skill| {
            skill.agent_type == "codex"
                && skill.scope_kind == "system"
                && skill.read_only
                && skill.name == "builtin"
        }));
        assert!(summaries.iter().any(|skill| {
            skill.scope_kind == "plugin"
                && skill.source_kind == "plugin"
                && skill.read_only
                && skill.enabled_state == "unknown"
        }));
        assert!(summaries.iter().any(|skill| {
            skill.agent_type == "cursor"
                && skill.source_kind == "filesystem"
                && skill.scope_kind == "user"
        }));
        let claude_duplicates = summaries
            .iter()
            .filter(|skill| skill.agent_type == "claude" && skill.name == "duplicate")
            .collect::<Vec<_>>();
        assert_eq!(claude_duplicates.len(), 2);
        assert!(claude_duplicates.iter().all(|skill| skill.duplicate_name));
    }

    #[test]
    fn get_and_read_skill_files_enforce_containment() {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let codex_home = home.join(".codex");
        let skill = write_skill(
            &home.join(".agents/skills"),
            "reader",
            "reader",
            "Read fixture",
        );
        fs::create_dir_all(skill.join("references")).unwrap();
        fs::write(skill.join("references/note.md"), "你好, Codex").unwrap();
        fs::write(temp.path().join("outside.txt"), "secret").unwrap();

        let database = database(&temp);
        let summaries = scan_skills_from(
            &database,
            &SkillScanRequest {
                project_ids: Vec::new(),
                include_plugin_cache: false,
            },
            &home,
            &codex_home,
        )
        .unwrap();
        let reader = summaries
            .iter()
            .find(|skill| skill.agent_type == "codex" && skill.name == "reader")
            .unwrap();

        let detail = get_skill(&database, &reader.id).unwrap();
        assert_eq!(detail.frontmatter["name"], "reader");
        assert!(detail
            .files
            .iter()
            .any(|file| file.path == "references/note.md" && file.kind == "markdown"));
        assert_eq!(
            read_skill_file(&database, &reader.id, "references/note.md").unwrap(),
            "你好, Codex"
        );
        assert!(matches!(
            read_skill_file(&database, &reader.id, "../outside.txt"),
            Err(AppError::InvalidInput(_))
        ));
        assert!(matches!(
            read_skill_file(
                &database,
                &reader.id,
                &temp.path().join("outside.txt").to_string_lossy()
            ),
            Err(AppError::InvalidInput(_))
        ));
    }

    #[test]
    fn incomplete_root_does_not_reconcile_stale_locations() {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let codex_home = home.join(".codex");
        let claude_root = home.join(".claude/skills");
        write_skill(
            &claude_root,
            "retained",
            "retained",
            "Retain on incomplete scan",
        );
        let database = database(&temp);
        let request = SkillScanRequest {
            project_ids: Vec::new(),
            include_plugin_cache: false,
        };
        let first = scan_skills_from(&database, &request, &home, &codex_home).unwrap();
        let retained_id = first
            .iter()
            .find(|skill| skill.agent_type == "claude" && skill.name == "retained")
            .unwrap()
            .id
            .clone();

        // A non-directory root stands in for a root whose metadata/read_dir
        // cannot be completed. It must not be reconciled as an empty root.
        fs::remove_dir_all(&claude_root).unwrap();
        fs::write(&claude_root, "temporarily inaccessible").unwrap();
        scan_skills_from(&database, &request, &home, &codex_home).unwrap();

        database
            .with_connection(|connection| {
                let retained: i64 = connection.query_row(
                    "SELECT COUNT(*) FROM skill_locations WHERE id = ?1",
                    [&retained_id],
                    |row| row.get(0),
                )?;
                assert_eq!(retained, 1);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn a_rescan_removes_stale_derived_locations() {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let codex_home = home.join(".codex");
        let skill = write_skill(
            &home.join(".claude/skills"),
            "temporary",
            "temporary",
            "Temporary skill",
        );
        let database = database(&temp);
        let request = SkillScanRequest {
            project_ids: Vec::new(),
            include_plugin_cache: false,
        };
        let first = scan_skills_from(&database, &request, &home, &codex_home).unwrap();
        let id = first
            .iter()
            .find(|skill| skill.agent_type == "claude")
            .unwrap()
            .id
            .clone();

        fs::remove_dir_all(skill).unwrap();
        let second = scan_skills_from(&database, &request, &home, &codex_home).unwrap();
        assert!(!second.iter().any(|summary| summary.id == id));
        assert!(matches!(
            get_skill(&database, &id),
            Err(AppError::NotFound(_))
        ));
    }
}
