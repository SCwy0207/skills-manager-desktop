export type Section = "sessions" | "skills" | "projects" | "activity" | "settings";

export interface CapabilityInfo {
  platform: string;
  codexCliAvailable: boolean;
  appServerAvailable: boolean;
  sessionSource: string;
  symlinkSupported: boolean;
  junctionSupported: boolean;
  noTelemetry: boolean;
}

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  trusted: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface TextRange {
  start: number;
  end: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  preview: string;
  cwd?: string | null;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  sourceKind: string;
  matchRanges: TextRange[];
}

export interface SessionDetail {
  summary: SessionSummary;
  content: string;
  filePath: string;
  metadata: Record<string, unknown>;
}

export interface SessionSearchRequest {
  query: string;
  archived?: boolean | null;
  cwd?: string | null;
  limit?: number;
  offset?: number;
}

export interface SkillSummary {
  id: string;
  name: string;
  displayName: string;
  description: string;
  agentType: string;
  scopeKind: string;
  sourceKind: string;
  path: string;
  enabledState: string;
  readOnly: boolean;
  managed: boolean;
  healthStatus: string;
  riskStatus: string;
  projectId?: string | null;
  duplicateName: boolean;
  updatedAt: number;
  descriptionLocalization?: SkillDescriptionLocalization | null;
  descriptionLocalizations?: SkillDescriptionLocalization[];
}

export interface SkillFile {
  path: string;
  size: number;
  kind: string;
}

export interface SkillDetail {
  summary: SkillSummary;
  files: SkillFile[];
  frontmatter: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface SkillScanRequest {
  projectIds: string[];
  includePluginCache: boolean;
}

export type SkillAgentType = "codex" | "claude" | "cursor";

export interface DeploymentTarget {
  agentType: SkillAgentType;
  scopeKind: "user" | "project";
  projectId?: string | null;
}

export interface ImportSkillRequest {
  sourcePath: string;
  targets: DeploymentTarget[];
  allowCopyFallback: boolean;
}

export interface SkillBindingSummary {
  id: string;
  agentType: string;
  scopeKind: string;
  linkPath: string;
  linkMode: string;
  healthStatus: string;
}

export interface ImportSkillResult {
  skillId: string;
  revisionId: string;
  name: string;
  treeHash: string;
  bindings: SkillBindingSummary[];
}

export interface WriteSkillFileRequest {
  locationId: string;
  relativePath: string;
  content: string;
  expectedHash: string;
}

export interface WriteSkillFileResult {
  contentHash: string;
  updatedAt: number;
}

export interface AuditLogEntry {
  id: number;
  actionType: string;
  targetId?: string | null;
  result: string;
  detail: Record<string, unknown>;
  createdAt: number;
}

export interface SecurityFinding {
  id: string;
  ruleId: string;
  severity: "critical" | "high" | "medium" | "low" | string;
  filePath?: string | null;
  line?: number | null;
  message: string;
  evidenceRedacted?: string | null;
}

export interface SecurityScanResult {
  locationId: string;
  status: "safe" | "review" | "risky" | "blocked" | string;
  scannedAt: number;
  findings: SecurityFinding[];
  scannedFiles: number;
  scannedBytes: number;
  skippedBinaryFiles: number;
  skippedOversizedFiles: number;
  skippedLinks: number;
}

export type AiDescriptionProviderId = "local" | "openai" | "compatible";
export type AiDescriptionMode = "translate" | "summarize";
export type SkillDescriptionLocalizationMode = "manual" | AiDescriptionMode;
export type SkillDescriptionLocalizationOrigin =
  | "manual"
  | "localModel"
  | "openai"
  | "openaiCompatible";
export type SkillDescriptionSourceScope = "description" | "manifestExcerpt";
export type SkillDescriptionLocalizationStatus =
  | "missing"
  | "notNeeded"
  | "ready"
  | "stale";

export interface SkillDescriptionLocalization {
  locale: "zh-CN";
  status: SkillDescriptionLocalizationStatus;
  text?: string;
  mode?: SkillDescriptionLocalizationMode;
  origin?: SkillDescriptionLocalizationOrigin;
  sourceScope?: SkillDescriptionSourceScope;
  providerId?: string;
  modelId?: string;
  generatedAt?: number;
}

export interface AiDescriptionSettings {
  enabled: boolean;
  provider: AiDescriptionProviderId;
  localEndpoint: string;
  localModel: string | null;
  openaiModel: string;
  compatibleBaseUrl: string;
  compatibleModel: string;
  compatibleApiKeyConfigured: boolean;
  defaultMode: AiDescriptionMode;
  openaiKeyState: "missing" | "stored" | "environment";
  localSecretStored: boolean;
}

export interface UpdateAiDescriptionSettingsRequest {
  enabled?: boolean;
  provider?: AiDescriptionProviderId;
  localEndpoint?: string;
  localModel?: string | null;
  openaiModel?: string;
  compatibleBaseUrl?: string;
  compatibleModel?: string;
  defaultMode?: AiDescriptionMode;
}

export interface AiProviderSecretStatus {
  providerId: "openai" | "compatible";
  configured: boolean;
  source: "credentialStore" | "environment" | "missing";
}

export interface LocalAiProvider {
  id: "ollama" | "lmStudio";
  name: string;
  endpoint: string;
  available: boolean;
  models: string[];
  error?: string;
}

export interface ProviderTestResult {
  ok: boolean;
  provider: AiDescriptionProviderId;
  model?: string;
  latencyMs: number;
  message: string;
}

export type AiProviderTestResult = ProviderTestResult;

export interface GenerateSkillDescriptionRequest {
  locationId: string;
  targetLocale: "zh-CN";
  mode: AiDescriptionMode;
  force: boolean;
  allowRemoteManifestExcerpt: boolean;
  expectedSourceHash?: string;
}

export interface SetManualSkillDescriptionRequest {
  locationId: string;
  targetLocale: "zh-CN";
  text: string;
}

export interface ClearSkillDescriptionRequest {
  locationId: string;
  targetLocale: "zh-CN";
  mode?: SkillDescriptionLocalizationMode;
}

export type SkillDescriptionJobScope = "filtered" | "project" | "all";
export type SkillDescriptionJobState =
  | "queued"
  | "running"
  | "completed"
  | "cancelled"
  | "failed";

export interface DescriptionBatchRequest {
  locationIds: string[];
  targetLocale: "zh-CN";
  mode: AiDescriptionMode;
  force: boolean;
  expectedSourceHashes?: Record<string, string>;
}

export interface SkillDescriptionJobFailure {
  locationId: string;
  code: string;
  message: string;
}

export interface SkillDescriptionJob {
  id: string;
  targetLocale: "zh-CN";
  mode: AiDescriptionMode;
  force: boolean;
  status: SkillDescriptionJobState;
  total: number;
  completed: number;
  succeeded: number;
  skipped: number;
  failed: number;
  currentLocationId?: string | null;
  failures: SkillDescriptionJobFailure[];
  startedAt: number;
  finishedAt?: number | null;
}

export type DescriptionJob = SkillDescriptionJob;
export type DescriptionJobFailure = SkillDescriptionJobFailure;
export type SkillDescriptionJobRequest = DescriptionBatchRequest;

export type AiDescriptionErrorCode =
  | "AI_NOT_CONFIGURED"
  | "AI_AUTH_ERROR"
  | "AI_OFFLINE"
  | "AI_TIMEOUT"
  | "AI_RATE_LIMIT"
  | "AI_RESPONSE_INVALID"
  | "AI_SENSITIVE_INPUT"
  | "AI_BODY_CONFIRM_REQUIRED"
  | "SOURCE_CHANGED"
  | "AI_ALREADY_RUNNING"
  | string;

export type SessionArchiveFilter = "active" | "archived" | "all";
export type SkillAgentFilter = "all" | "codex" | "claude" | "cursor";
export type SkillScopeFilter = "all" | "user" | "repo" | "plugin" | "system";
export type SkillStatusFilter = "all" | "enabled" | "disabled" | "issues";
