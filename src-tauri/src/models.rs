use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityInfo {
    pub platform: String,
    pub codex_cli_available: bool,
    pub app_server_available: bool,
    pub session_source: String,
    pub symlink_supported: bool,
    pub junction_supported: bool,
    pub no_telemetry: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub trusted: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub cwd: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived: bool,
    pub source_kind: String,
    pub match_ranges: Vec<TextRange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetail {
    pub summary: SessionSummary,
    pub content: String,
    pub file_path: String,
    pub metadata: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchRequest {
    pub query: String,
    pub archived: Option<bool>,
    pub cwd: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub agent_type: String,
    pub scope_kind: String,
    pub source_kind: String,
    pub path: String,
    pub enabled_state: String,
    pub read_only: bool,
    pub managed: bool,
    pub health_status: String,
    pub risk_status: String,
    pub project_id: Option<String>,
    pub duplicate_name: bool,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description_localization: Option<SkillDescriptionLocalization>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub description_localizations: Vec<SkillDescriptionLocalization>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetail {
    pub summary: SkillSummary,
    pub files: Vec<SkillFile>,
    pub frontmatter: serde_json::Value,
    pub metadata: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFile {
    pub path: String,
    pub size: u64,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillScanRequest {
    pub project_ids: Vec<String>,
    pub include_plugin_cache: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentTarget {
    pub agent_type: String,
    pub scope_kind: String,
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSkillRequest {
    pub source_path: String,
    pub targets: Vec<DeploymentTarget>,
    pub allow_copy_fallback: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillBindingSummary {
    pub id: String,
    pub agent_type: String,
    pub scope_kind: String,
    pub link_path: String,
    pub link_mode: String,
    pub health_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSkillResult {
    pub skill_id: String,
    pub revision_id: String,
    pub name: String,
    pub tree_hash: String,
    pub bindings: Vec<SkillBindingSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteSkillFileRequest {
    pub location_id: String,
    pub relative_path: String,
    pub content: String,
    pub expected_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteSkillFileResult {
    pub content_hash: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditLogEntry {
    pub id: i64,
    pub action_type: String,
    pub target_id: Option<String>,
    pub result: String,
    pub detail: serde_json::Value,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillDescriptionLocalization {
    pub locale: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generated_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiDescriptionSettings {
    pub enabled: bool,
    pub provider: String,
    pub local_endpoint: String,
    pub local_model: Option<String>,
    pub openai_model: String,
    #[serde(default)]
    pub compatible_base_url: String,
    #[serde(default)]
    pub compatible_model: String,
    #[serde(default)]
    pub compatible_api_key_configured: bool,
    pub default_mode: String,
    pub openai_key_state: String,
    pub local_secret_stored: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAiDescriptionSettingsRequest {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub local_endpoint: Option<String>,
    #[serde(default, deserialize_with = "deserialize_nullable_string_patch")]
    pub local_model: Option<Option<String>>,
    #[serde(default)]
    pub openai_model: Option<String>,
    #[serde(default)]
    pub compatible_base_url: Option<String>,
    #[serde(default)]
    pub compatible_model: Option<String>,
    #[serde(default)]
    pub default_mode: Option<String>,
}

fn deserialize_nullable_string_patch<'de, D>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalAiProvider {
    pub id: String,
    pub name: String,
    pub endpoint: String,
    pub available: bool,
    pub models: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTestResult {
    pub ok: bool,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub message: String,
    pub latency_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateSkillDescriptionRequest {
    pub location_id: String,
    #[serde(default = "default_zh_cn")]
    pub target_locale: String,
    pub mode: String,
    #[serde(default)]
    pub force: bool,
    #[serde(default)]
    pub allow_remote_manifest_excerpt: bool,
    #[serde(default)]
    pub expected_source_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetManualSkillDescriptionRequest {
    pub location_id: String,
    #[serde(default = "default_zh_cn")]
    pub target_locale: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearSkillDescriptionRequest {
    pub location_id: String,
    #[serde(default = "default_zh_cn")]
    pub target_locale: String,
    pub mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartSkillDescriptionJobRequest {
    pub location_ids: Vec<String>,
    #[serde(default = "default_zh_cn")]
    pub target_locale: String,
    pub mode: String,
    #[serde(default)]
    pub force: bool,
    #[serde(default)]
    pub expected_source_hashes: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillDescriptionJobFailure {
    pub location_id: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillDescriptionJob {
    pub id: String,
    pub target_locale: String,
    pub mode: String,
    pub force: bool,
    pub status: String,
    pub total: usize,
    pub completed: usize,
    pub succeeded: usize,
    pub skipped: usize,
    pub failed: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_location_id: Option<String>,
    pub failures: Vec<SkillDescriptionJobFailure>,
    pub started_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
}

fn default_zh_cn() -> String {
    "zh-CN".to_owned()
}

#[cfg(test)]
mod tests {
    use super::{AiDescriptionSettings, SkillDescriptionJob, UpdateAiDescriptionSettingsRequest};

    #[test]
    fn compatible_settings_use_the_public_camel_case_contract() {
        let settings = AiDescriptionSettings {
            enabled: true,
            provider: "compatible".to_owned(),
            local_endpoint: "http://127.0.0.1:11434".to_owned(),
            local_model: None,
            openai_model: "gpt-5.6-luna".to_owned(),
            compatible_base_url: "https://example.invalid/v1".to_owned(),
            compatible_model: "example-model".to_owned(),
            compatible_api_key_configured: true,
            default_mode: "summarize".to_owned(),
            openai_key_state: "missing".to_owned(),
            local_secret_stored: false,
        };

        let value = serde_json::to_value(settings).expect("settings serialize");
        assert_eq!(value["compatibleBaseUrl"], "https://example.invalid/v1");
        assert_eq!(value["compatibleModel"], "example-model");
        assert_eq!(value["compatibleApiKeyConfigured"], true);
        assert!(value.get("compatible_base_url").is_none());
    }

    #[test]
    fn legacy_settings_patch_can_omit_compatible_fields() {
        let request: UpdateAiDescriptionSettingsRequest =
            serde_json::from_value(serde_json::json!({ "provider": "openai" }))
                .expect("legacy patch deserialize");

        assert_eq!(request.provider.as_deref(), Some("openai"));
        assert!(request.compatible_base_url.is_none());
        assert!(request.compatible_model.is_none());
    }

    #[test]
    fn legacy_settings_payload_deserializes_with_compatible_defaults() {
        let settings: AiDescriptionSettings = serde_json::from_value(serde_json::json!({
            "enabled": false,
            "provider": "openai",
            "localEndpoint": "http://127.0.0.1:11434",
            "localModel": null,
            "openaiModel": "gpt-5.6-luna",
            "defaultMode": "summarize",
            "openaiKeyState": "missing",
            "localSecretStored": false
        }))
        .expect("legacy settings deserialize");

        assert!(settings.compatible_base_url.is_empty());
        assert!(settings.compatible_model.is_empty());
        assert!(!settings.compatible_api_key_configured);
    }

    #[test]
    fn description_job_exposes_the_strategy_used_for_retry_review() {
        let value = serde_json::to_value(SkillDescriptionJob {
            id: "job-1".to_owned(),
            target_locale: "zh-CN".to_owned(),
            mode: "translate".to_owned(),
            force: true,
            status: "completed".to_owned(),
            total: 1,
            completed: 1,
            succeeded: 0,
            skipped: 0,
            failed: 1,
            current_location_id: None,
            failures: Vec::new(),
            started_at: 1,
            finished_at: Some(2),
        })
        .expect("job serialize");

        assert_eq!(value["targetLocale"], "zh-CN");
        assert_eq!(value["mode"], "translate");
        assert_eq!(value["force"], true);
        assert!(value.get("target_locale").is_none());
    }
}
