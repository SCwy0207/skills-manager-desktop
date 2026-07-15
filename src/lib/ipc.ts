import { invoke } from "@tauri-apps/api/core";

import type {
  AiDescriptionErrorCode,
  AiDescriptionMode,
  AiDescriptionProviderId,
  AiDescriptionSettings,
  AiProviderTestResult,
  AuditLogEntry,
  CapabilityInfo,
  ClearSkillDescriptionRequest,
  GenerateSkillDescriptionRequest,
  ImportSkillRequest,
  ImportSkillResult,
  LocalAiProvider,
  Project,
  SessionDetail,
  SessionSearchRequest,
  SessionSummary,
  SecurityScanResult,
  SetManualSkillDescriptionRequest,
  SkillDescriptionJob,
  SkillDescriptionJobRequest,
  SkillDescriptionLocalization,
  SkillDescriptionLocalizationMode,
  SkillDetail,
  SkillScanRequest,
  SkillSummary,
  UpdateAiDescriptionSettingsRequest,
  WriteSkillFileRequest,
  WriteSkillFileResult,
} from "../types";
import { translateNow } from "../i18n/i18n";
import { sha256Text } from "./hash";

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

export const isTauriRuntime =
  typeof window !== "undefined" && Boolean((window as TauriWindow).__TAURI_INTERNALS__);

function safeAiResponseDetail(message: string) {
  const withoutPrefix = message.replace(
    /^AI provider returned an invalid response:\s*/iu,
    "",
  );
  if (
    /[{}]/u.test(withoutPrefix) ||
    /-----BEGIN|\bBearer\s+|\bsk-[A-Za-z0-9_-]{8,}|(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\//iu.test(withoutPrefix)
  ) {
    return undefined;
  }
  const detail = withoutPrefix
    .replace(/https?:\/\/[^\s<>"']+/giu, "[endpoint redacted]")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 240);
  return detail && detail !== message.trim() ? detail : undefined;
}

export class DesktopApiError extends Error {
  readonly code: AiDescriptionErrorCode;
  readonly retryable: boolean;
  readonly detail?: string;

  constructor(message: string, code: AiDescriptionErrorCode = "DESKTOP_API_ERROR", retryable = false) {
    const translationKey = `skills.error.code.${code}`;
    const translatedMessage = translateNow(translationKey);
    const hasTranslation = translatedMessage !== translationKey;
    const detail = code === "AI_RESPONSE_INVALID" && hasTranslation
      ? safeAiResponseDetail(message)
      : undefined;
    super(hasTranslation ? [translatedMessage, detail].filter(Boolean).join(" ") : message);
    this.name = "DesktopApiError";
    this.code = code;
    this.retryable = retryable;
    this.detail = detail;
  }
}

const sleep = (milliseconds = 160) =>
  new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds));

const now = Math.floor(Date.now() / 1000);

let mockAuditSequence = 5;
let mockAuditLogs: AuditLogEntry[] = [
  { id: 4, actionType: "SKILL_SCAN", targetId: null, result: "success", detail: { count: 8 }, createdAt: now - 40 },
  { id: 3, actionType: "SESSION_INDEX", targetId: null, result: "success", detail: { changed: 6 }, createdAt: now - 310 },
  { id: 2, actionType: "SKILL_ENABLE", targetId: "skill-deploy-helper", result: "success", detail: { enabled: false }, createdAt: now - 7200 },
  { id: 1, actionType: "SKILL_IMPORT", targetId: "skill-pdf-user", result: "success", detail: { targets: 1 }, createdAt: now - 86400 },
];
const mockSecurityScans = new Map<string, SecurityScanResult>();
let mockAiSettings: AiDescriptionSettings = {
  enabled: false,
  provider: "local",
  localEndpoint: "http://127.0.0.1:11434",
  localModel: "qwen3:4b",
  openaiModel: "gpt-5.6-luna",
  compatibleBaseUrl: "https://api.example.com",
  compatibleModel: "gpt-4o-mini",
  compatibleApiKeyConfigured: false,
  defaultMode: "summarize",
  openaiKeyState: "missing",
  localSecretStored: false,
};
let mockOpenAiSecretConfigured = false;
let mockCompatibleSecretConfigured = false;
const mockLocalizations = new Map<string, SkillDescriptionLocalization>();
const mockDescriptionJobs = new Map<
  string,
  {
    job: SkillDescriptionJob;
    pendingLocationIds: string[];
    force: boolean;
    provider: "local" | "openai" | "compatible";
    mode: AiDescriptionMode;
  }
>();

function recordMockAudit(
  actionType: string,
  targetId: string | null,
  detail: Record<string, unknown>,
  result = "success",
) {
  mockAuditLogs = [
    {
      id: mockAuditSequence++,
      actionType,
      targetId,
      result,
      detail,
      createdAt: Math.floor(Date.now() / 1000),
    },
    ...mockAuditLogs,
  ];
}

let mockProjects: Project[] = [
  {
    id: "project-control-center",
    name: "skill-manager",
    rootPath: "D:\\Projects\\skills-manager",
    trusted: true,
    createdAt: now - 86400 * 8,
    updatedAt: now - 120,
  },
  {
    id: "project-atlas",
    name: "atlas-notes",
    rootPath: "D:\\Projects\\demo-project",
    trusted: true,
    createdAt: now - 86400 * 25,
    updatedAt: now - 4320,
  },
];

const mockSessionContent: Record<string, string> = {
  "session-architecture": `用户：为 Skills Manager 设计一套本地优先的桌面架构。\n\n助手：建议采用 Tauri 2 + React 19。Rust 负责会话扫描、Skills 发现和 SQLite 索引，前端只维护交互状态。会话正文进入 FTS 索引，同时保留针对中文的子串检索回退。\n\n实现重点：\n1. Codex 会话以本地文件为数据源。\n2. Codex、Claude Code 与 Cursor Skills 统一展示。\n3. 所有变更写入审计日志，不采集遥测。`,
  "session-search": `用户：中文会话为什么搜索不到？\n\n助手：unicode61 分词对连续中文文本的体验有限。索引阶段增加规范化文本，并为标题和正文提供字面子串匹配；结果返回命中片段，由界面高亮关键词。`,
  "session-skill-review": `用户：检查 deploy-helper Skill 是否安全。\n\n助手：静态检查发现 scripts/deploy.ps1 会启动外部进程并访问网络。没有发现凭据明文，但建议保持禁用，审阅允许域名后再启用。`,
  "session-tauri": `用户：把桌面壳切换到 Tauri。\n\n助手：已完成能力边界设计。WebView 不获得任意 shell 或文件系统权限，所有请求都通过 Rust command 校验路径和参数。`,
  "session-migration": `用户：升级 SQLite 表结构。\n\n助手：迁移增加 projects、skill_locations 与 audit_logs，并启用 WAL、foreign_keys 和 busy_timeout。`,
  "session-release": `用户：准备个人开发者预览版。\n\n助手：预览版默认关闭遥测，只保留本地诊断日志。安装包覆盖 Windows、macOS 和 Linux。`,
};

const mockSessions: SessionSummary[] = [
  {
    id: "session-architecture",
    title: "Skills Manager 架构设计",
    preview: "采用 Tauri 2 + React 19，统一管理本地会话和多 Agent Skills…",
    cwd: "D:\\Projects\\skills-manager",
    createdAt: now - 86400 * 2,
    updatedAt: now - 280,
    archived: false,
    sourceKind: "codex",
    matchRanges: [],
  },
  {
    id: "session-search",
    title: "实现中英文会话全文搜索",
    preview: "为连续中文内容增加子串检索，并在结果中生成命中片段和高亮…",
    cwd: "D:\\Projects\\skills-manager",
    createdAt: now - 86400,
    updatedAt: now - 1780,
    archived: false,
    sourceKind: "codex",
    matchRanges: [],
  },
  {
    id: "session-skill-review",
    title: "审阅 deploy-helper Skill",
    preview: "静态检查发现 PowerShell 脚本包含外部进程和网络访问…",
    cwd: "D:\\Projects\\demo-project",
    createdAt: now - 86400 * 3,
    updatedAt: now - 9100,
    archived: false,
    sourceKind: "codex",
    matchRanges: [],
  },
  {
    id: "session-tauri",
    title: "Tauri 权限边界与 IPC",
    preview: "收紧 WebView 权限，文件与进程操作统一由 Rust commands 处理…",
    cwd: "D:\\Projects\\skills-manager",
    createdAt: now - 86400 * 6,
    updatedAt: now - 86400 * 2,
    archived: false,
    sourceKind: "codex",
    matchRanges: [],
  },
  {
    id: "session-migration",
    title: "SQLite 索引迁移",
    preview: "增加项目、技能位置与审计表，启用 WAL 和外键约束…",
    cwd: "D:\\Projects\\skills-manager",
    createdAt: now - 86400 * 10,
    updatedAt: now - 86400 * 6,
    archived: true,
    sourceKind: "codex",
    matchRanges: [],
  },
  {
    id: "session-release",
    title: "个人开发者预览版发布清单",
    preview: "本地优先、无遥测，准备三个桌面平台的安装包…",
    cwd: null,
    createdAt: now - 86400 * 20,
    updatedAt: now - 86400 * 12,
    archived: true,
    sourceKind: "codex",
    matchRanges: [],
  },
];

const mockSkills: SkillSummary[] = [
  {
    id: "skill-openai-docs",
    name: "openai-docs",
    displayName: "OpenAI Docs",
    description: "Answer questions using official OpenAI documentation and provide reliable citations.",
    agentType: "codex",
    scopeKind: "system",
    sourceKind: "system",
    path: "C:\\Users\\ExampleUser\\.codex\\skills\\.system\\openai-docs",
    enabledState: "enabled",
    readOnly: true,
    managed: false,
    healthStatus: "healthy",
    riskStatus: "safe",
    projectId: null,
    duplicateName: false,
    updatedAt: now - 860,
  },
  {
    id: "skill-skill-creator",
    name: "skill-creator",
    displayName: "Skill Creator",
    description: "创建和维护高质量 Agent Skill 的标准工作流。",
    agentType: "codex",
    scopeKind: "system",
    sourceKind: "system",
    path: "C:\\Users\\ExampleUser\\.codex\\skills\\.system\\skill-creator",
    enabledState: "enabled",
    readOnly: true,
    managed: false,
    healthStatus: "healthy",
    riskStatus: "safe",
    projectId: null,
    duplicateName: false,
    updatedAt: now - 1900,
  },
  {
    id: "skill-documents",
    name: "documents",
    displayName: "Documents",
    description: "创建、编辑与视觉校验 Word 文档。",
    agentType: "codex",
    scopeKind: "plugin",
    sourceKind: "plugin",
    path: "C:\\Users\\ExampleUser\\.codex\\plugins\\cache\\runtime\\documents",
    enabledState: "enabled",
    readOnly: true,
    managed: false,
    healthStatus: "healthy",
    riskStatus: "safe",
    projectId: null,
    duplicateName: false,
    updatedAt: now - 3600,
  },
  {
    id: "skill-release-notes",
    name: "release-notes",
    displayName: "Release Notes",
    description: "根据 Git 历史生成结构清晰的中英文发布说明。",
    agentType: "codex",
    scopeKind: "repo",
    sourceKind: "filesystem",
    path: "D:\\Projects\\skills-manager\\.agents\\skills\\release-notes",
    enabledState: "enabled",
    readOnly: false,
    managed: false,
    healthStatus: "healthy",
    riskStatus: "safe",
    projectId: "project-control-center",
    duplicateName: false,
    updatedAt: now - 310,
  },
  {
    id: "skill-deploy-helper",
    name: "deploy-helper",
    displayName: "Deploy Helper",
    description: "Build desktop installers and synchronize approved release assets.",
    agentType: "claude",
    scopeKind: "repo",
    sourceKind: "filesystem",
    path: "D:\\Projects\\demo-project\\.claude\\skills\\deploy-helper",
    enabledState: "disabled",
    readOnly: false,
    managed: false,
    healthStatus: "warning",
    riskStatus: "review",
    projectId: "project-atlas",
    duplicateName: false,
    updatedAt: now - 8400,
  },
  {
    id: "skill-note-curator",
    name: "note-curator",
    displayName: "Note Curator",
    description: "Organize project notes, merge duplicates, and maintain the project index.",
    agentType: "cursor",
    scopeKind: "repo",
    sourceKind: "filesystem",
    path: "D:\\Projects\\demo-project\\.cursor\\skills\\note-curator",
    enabledState: "enabled",
    readOnly: false,
    managed: false,
    healthStatus: "healthy",
    riskStatus: "safe",
    projectId: "project-atlas",
    duplicateName: false,
    updatedAt: now - 6400,
  },
  {
    id: "skill-pdf-user",
    name: "pdf",
    displayName: "PDF Toolkit",
    description: "读取、生成和检查 PDF 文件。",
    agentType: "codex",
    scopeKind: "user",
    sourceKind: "local-import",
    path: "C:\\Users\\ExampleUser\\.agents\\skills\\pdf",
    enabledState: "enabled",
    readOnly: true,
    managed: true,
    healthStatus: "healthy",
    riskStatus: "safe",
    projectId: null,
    duplicateName: true,
    updatedAt: now - 740,
  },
  {
    id: "skill-pdf-plugin",
    name: "pdf",
    displayName: "PDF",
    description: "插件提供的 PDF 处理工作流。",
    agentType: "codex",
    scopeKind: "plugin",
    sourceKind: "plugin",
    path: "C:\\Users\\ExampleUser\\.codex\\plugins\\cache\\runtime\\pdf",
    enabledState: "enabled",
    readOnly: true,
    managed: false,
    healthStatus: "healthy",
    riskStatus: "safe",
    projectId: null,
    duplicateName: true,
    updatedAt: now - 4200,
  },
];

const skillReadmes: Record<string, string> = {
  "skill-openai-docs": `---\nname: openai-docs\ndescription: Answer questions using official OpenAI documentation.\n---\n\n# OpenAI Docs\n\nUse the official documentation tools first. Restrict fallback browsing to OpenAI domains and cite every time-sensitive statement.`,
  "skill-skill-creator": `---\nname: skill-creator\ndescription: Create and update effective Codex skills.\n---\n\n# Skill Creator\n\nDefine clear trigger rules, keep the primary workflow concise, and move optional detail into references.`,
  "skill-documents": `---\nname: documents\ndescription: Create and edit Word documents.\n---\n\n# Documents\n\nRender every document before delivery and inspect all pages for layout defects.`,
  "skill-release-notes": `---\nname: release-notes\ndescription: Generate clear bilingual release notes from Git history.\n---\n\n# Release Notes\n\n1. Read commits since the latest tag.\n2. Group user-visible changes by feature.\n3. Produce concise Chinese and English summaries.`,
  "skill-deploy-helper": `---\nname: deploy-helper\ndescription: Build installers and synchronize release assets.\n---\n\n# Deploy Helper\n\nRun the platform build, calculate checksums, then upload approved assets.\n\n> This skill is disabled until its network destinations are reviewed.`,
  "skill-note-curator": `---\nname: note-curator\ndescription: Organize project notes and maintain their index.\n---\n\n# Note Curator\n\nFind duplicate notes, preserve source references, and update the project index.`,
  "skill-pdf-user": `---\nname: pdf\ndescription: Read, create and visually inspect PDF files.\n---\n\n# PDF Toolkit\n\nRender pages to images for visual verification before delivering output.`,
  "skill-pdf-plugin": `---\nname: pdf\ndescription: Plugin-provided PDF workflow.\n---\n\n# PDF\n\nInspect and render PDF documents using the bundled runtime.`,
};

const mockFileOverrides: Record<string, Record<string, string>> = {};

function mockLocalizationKey(skillId: string, mode: SkillDescriptionLocalizationMode) {
  return `${skillId}:${mode}`;
}

function containsChinese(value: string) {
  return /[\u3400-\u9fff]/u.test(value);
}

function descriptionLocalizationFor(skill: SkillSummary): SkillDescriptionLocalization {
  const manual = mockLocalizations.get(mockLocalizationKey(skill.id, "manual"));
  if (manual) return manual;
  const preferred = mockLocalizations.get(
    mockLocalizationKey(skill.id, mockAiSettings.defaultMode),
  );
  if (preferred) return preferred;
  const fallbackMode = mockAiSettings.defaultMode === "summarize" ? "translate" : "summarize";
  const fallback = mockLocalizations.get(mockLocalizationKey(skill.id, fallbackMode));
  if (fallback) return fallback;
  return {
    locale: "zh-CN",
    status: containsChinese(skill.description) ? "notNeeded" : "missing",
  };
}

function descriptionLocalizationsFor(skill: SkillSummary): SkillDescriptionLocalization[] {
  return (["manual", "translate", "summarize"] as const)
    .map((mode) => mockLocalizations.get(mockLocalizationKey(skill.id, mode)))
    .filter((localization): localization is SkillDescriptionLocalization => Boolean(localization));
}

function decoratedSkill(skill: SkillSummary): SkillSummary {
  return {
    ...skill,
    descriptionLocalization: descriptionLocalizationFor(skill),
    descriptionLocalizations: descriptionLocalizationsFor(skill),
  };
}

function validateMockLocalEndpoint(endpoint: string) {
  if (!/^http:\/\/(?:127\.0\.0\.1|\[::1\]):\d+\/?$/u.test(endpoint.trim())) {
    throw new DesktopApiError(
      "本机模型地址只能使用 127.0.0.1 或 [::1]、显式端口，且不能包含 API 路径",
      "AI_NOT_CONFIGURED",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new DesktopApiError("本机模型地址无效", "AI_NOT_CONFIGURED");
  }
  if (
    parsed.protocol !== "http:" ||
    (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.pathname !== "/"
  ) {
    throw new DesktopApiError(
      "本机模型地址只能使用 127.0.0.1 或 [::1]，且不能包含凭据、查询参数或片段",
      "AI_NOT_CONFIGURED",
    );
  }
}

/** Validated user-facing Base URL. It preserves an explicitly supplied API path. */
export function normalizeCompatibleBaseUrl(baseUrl: string) {
  const raw = baseUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new DesktopApiError("OpenAI-compatible Base URL 无效", "AI_NOT_CONFIGURED");
  }
  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    raw.includes("?") ||
    raw.includes("#") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new DesktopApiError(
      "OpenAI-compatible Base URL 必须使用 HTTPS，且不能包含凭据、查询参数或片段",
      "AI_NOT_CONFIGURED",
    );
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/u, "");
  const mappedIpv4 = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/u.exec(hostname);
  const mappedIpv4Loopback = Boolean(
    mappedIpv4 && (Number.parseInt(mappedIpv4[1], 16) & 0xff00) === 0x7f00,
  ) || /^\[::ffff:127(?:\.\d{1,3}){3}\]$/u.test(hostname);
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname) ||
    hostname === "[::1]" ||
    mappedIpv4Loopback
  ) {
    throw new DesktopApiError(
      "OpenAI-compatible Base URL 不能使用本机回环地址；请改用本机模型 Provider",
      "AI_NOT_CONFIGURED",
    );
  }
  const path = parsed.pathname.replace(/\/+$/u, "");
  return `${parsed.origin}${path}`;
}

/** Canonical request endpoint used by the compatible request and confirmation hash. */
export function normalizeCompatibleEndpoint(baseUrl: string) {
  const parsed = new URL(normalizeCompatibleBaseUrl(baseUrl));
  let path = parsed.pathname.replace(/\/+$/u, "");
  if (!path) path = "/chat/completions";
  else if (!path.endsWith("/chat/completions")) path += "/chat/completions";
  return `${parsed.origin}${path}`;
}

function requireMockAiEnabled(provider = mockAiSettings.provider) {
  if (!mockAiSettings.enabled) {
    throw new DesktopApiError("请先在设置中启用 AI 中文简介", "AI_NOT_CONFIGURED");
  }
  if (provider === "local") {
    validateMockLocalEndpoint(mockAiSettings.localEndpoint);
    if (!mockAiSettings.localModel?.trim()) {
      throw new DesktopApiError("请选择本机模型", "AI_NOT_CONFIGURED");
    }
  } else if (provider === "openai" && !mockOpenAiSecretConfigured) {
    throw new DesktopApiError("尚未配置 OpenAI API Key", "AI_AUTH_ERROR");
  } else if (provider === "compatible") {
    normalizeCompatibleEndpoint(mockAiSettings.compatibleBaseUrl);
    if (!mockAiSettings.compatibleModel.trim()) {
      throw new DesktopApiError("OpenAI-compatible 模型名称不能为空", "AI_NOT_CONFIGURED");
    }
    if (!mockCompatibleSecretConfigured) {
      throw new DesktopApiError("尚未配置 OpenAI-compatible API Key", "AI_NOT_CONFIGURED");
    }
  }
}

function assertMockSkillSafeForRemote(skill: SkillSummary) {
  const source = `${skill.name}\n${skill.description}\n${mockedSkillFile(skill.id, "SKILL.md")}`;
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(source) ||
    /\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+\/-]{12,})\b/iu.test(source) ||
    /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s]+/iu.test(source)
  ) {
    throw new DesktopApiError(
      "Skill 文本可能包含凭据或连接串，已阻止发送到远程模型",
      "AI_SENSITIVE_INPUT",
    );
  }
}

function mockRemoteConfirmationPayload(
  skill: SkillSummary,
  mode: AiDescriptionMode,
  sourceScope: "description" | "manifestExcerpt",
  source: string,
) {
  const provider = mockAiSettings.provider;
  const model = provider === "compatible"
    ? mockAiSettings.compatibleModel
    : mockAiSettings.openaiModel;
  const fields = [
    "skill-description-confirmation-v1",
    provider,
    model,
  ];
  if (provider === "compatible") {
    fields.push(normalizeCompatibleEndpoint(mockAiSettings.compatibleBaseUrl));
  }
  fields.push(
    "zh-CN",
    mode,
    skill.name,
    sourceScope,
    source,
  );
  return fields.join("\u0000");
}

function createMockLocalization(
  skill: SkillSummary,
  mode: "translate" | "summarize",
  provider: "local" | "openai" | "compatible",
): SkillDescriptionLocalization {
  if (provider !== "local") assertMockSkillSafeForRemote(skill);
  const text =
    mode === "translate"
      ? `该技能按照作者声明的流程处理 ${skill.displayName} 相关任务，并提供清晰、可核验的执行结果与交付支持。`
      : `用于执行 ${skill.displayName} 相关工作流：理解技能约束，完成核心任务，并在交付前检查结果的完整性与可靠性。`;
  const localization: SkillDescriptionLocalization = {
    locale: "zh-CN",
    status: "ready",
    text: text.slice(0, 100),
    mode,
    origin:
      provider === "openai"
        ? "openai"
        : provider === "compatible"
          ? "openaiCompatible"
          : "localModel",
    sourceScope:
      mode === "translate" || provider !== "local" ? "description" : "manifestExcerpt",
    providerId: provider === "local" ? "ollama" : provider,
    modelId:
      provider === "openai"
        ? mockAiSettings.openaiModel
        : provider === "compatible"
          ? mockAiSettings.compatibleModel
          : (mockAiSettings.localModel ?? undefined),
    generatedAt: Math.floor(Date.now() / 1000),
  };
  mockLocalizations.set(mockLocalizationKey(skill.id, mode), localization);
  return localization;
}

function advanceMockDescriptionJob(state: {
  job: SkillDescriptionJob;
  pendingLocationIds: string[];
  force: boolean;
  provider: "local" | "openai" | "compatible";
  mode: AiDescriptionMode;
}) {
  if (state.job.status === "queued") state.job.status = "running";
  if (state.job.status !== "running") return;
  const locationId = state.pendingLocationIds.shift();
  if (!locationId) {
    state.job.status = "completed";
    state.job.currentLocationId = null;
    state.job.finishedAt = Math.floor(Date.now() / 1000);
    return;
  }
  state.job.currentLocationId = locationId;
  const skill = mockSkills.find((candidate) => candidate.id === locationId);
  if (!skill) {
    state.job.failed += 1;
    state.job.failures.push({
      locationId,
      code: "SKILL_NOT_FOUND",
      message: "Skill 不存在或已被移动",
    });
  } else {
    const manual = mockLocalizations.has(mockLocalizationKey(locationId, "manual"));
    const existing = mockLocalizations.has(mockLocalizationKey(locationId, state.mode));
    if (manual || (existing && !state.force) || (containsChinese(skill.description) && !state.force)) {
      state.job.skipped += 1;
    } else {
      try {
        createMockLocalization(skill, state.mode, state.provider);
        state.job.succeeded += 1;
      } catch (error) {
        const apiError = toDesktopApiError(error);
        state.job.failed += 1;
        state.job.failures.push({
          locationId,
          code: apiError.code,
          message: apiError.message,
        });
      }
    }
  }
  state.job.completed += 1;
  if (state.pendingLocationIds.length === 0) {
    state.job.status = "completed";
    state.job.currentLocationId = null;
    state.job.finishedAt = Math.floor(Date.now() / 1000);
  }
}

function skillDetail(skill: SkillSummary): SkillDetail {
  const hasScript = skill.id === "skill-deploy-helper";
  const manifest = mockedSkillFile(skill.id, "SKILL.md");
  return {
    summary: decoratedSkill(skill),
    files: [
      { path: "SKILL.md", size: manifest.length || 320, kind: "markdown" },
      { path: "agents/openai.yaml", size: 184, kind: "yaml" },
      ...(hasScript
        ? [{ path: "scripts/deploy.ps1", size: 1620, kind: "powershell" }]
        : []),
    ],
    frontmatter: {
      name: skill.name,
      description: skill.description,
    },
    metadata: {
      discoveredBy: skill.agentType,
      lastScannedAt: new Date((now - 42) * 1000).toISOString(),
      contentHash: `sha256:${skill.id.replace("skill-", "")}8c4e`,
    },
  };
}

function mockedSkillFile(id: string, relativePath: string) {
  const override = mockFileOverrides[id]?.[relativePath];
  if (override !== undefined) return override;
  if (relativePath === "SKILL.md") return skillReadmes[id] ?? "# Skill\n";
  if (relativePath.endsWith("openai.yaml")) {
    const skill = mockSkills.find((candidate) => candidate.id === id);
    return `interface:\n  display_name: "${skill?.displayName ?? "Skill"}"\n  short_description: "${skill?.description ?? ""}"\n`;
  }
  if (relativePath.endsWith("deploy.ps1")) {
    return `param([string]$Target = "preview")\n\npnpm tauri build\nInvoke-RestMethod -Uri $env:RELEASE_ENDPOINT -Method Post\n`;
  }
  return "";
}

async function mockInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  await sleep();
  switch (command) {
    case "get_capabilities":
      return {
        platform: "windows",
        codexCliAvailable: true,
        appServerAvailable: false,
        sessionSource: "filesystem-fallback",
        symlinkSupported: false,
        junctionSupported: true,
        noTelemetry: true,
      } as T;
    case "list_projects":
      return [...mockProjects] as T;
    case "add_project": {
      const path = String(args?.path ?? "").trim().replace(/[\\/]+$/, "");
      if (!path) throw new Error("请输入项目目录");
      const existing = mockProjects.find(
        (project) => project.rootPath.toLocaleLowerCase() === path.toLocaleLowerCase(),
      );
      if (existing) return existing as T;
      const project: Project = {
        id: `project-${Date.now()}`,
        name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? "New Project",
        rootPath: path,
        trusted: Boolean(args?.trusted),
        createdAt: now,
        updatedAt: now,
      };
      mockProjects = [project, ...mockProjects];
      return project as T;
    }
    case "remove_project":
      mockProjects = mockProjects.filter((project) => project.id !== args?.id);
      return undefined as T;
    case "index_sessions":
      await sleep(520);
      recordMockAudit("SESSION_INDEX", null, { changed: mockSessions.length });
      return mockSessions.length as T;
    case "search_sessions": {
      const request = (args?.request ?? {}) as SessionSearchRequest;
      const query = request.query?.trim().toLocaleLowerCase() ?? "";
      const result = mockSessions.filter((session) => {
        if (typeof request.archived === "boolean" && session.archived !== request.archived) {
          return false;
        }
        if (request.cwd && session.cwd !== request.cwd) return false;
        if (!query) return true;
        const haystack = `${session.title}\n${session.preview}\n${mockSessionContent[session.id] ?? ""}`.toLocaleLowerCase();
        return haystack.includes(query);
      });
      return result.slice(request.offset ?? 0, (request.offset ?? 0) + (request.limit ?? 100)) as T;
    }
    case "get_session": {
      const summary = mockSessions.find((session) => session.id === args?.id);
      if (!summary) throw new Error("会话不存在或已被移动");
      return {
        summary,
        content: mockSessionContent[summary.id] ?? summary.preview,
        filePath: `C:\\Users\\ExampleUser\\.codex\\sessions\\2026\\07\\${summary.id}.jsonl`,
        metadata: { model: "gpt-5", cwd: summary.cwd, source: "local" },
      } as T;
    }
    case "scan_skills": {
      await sleep(360);
      const request = (args?.request ?? {}) as SkillScanRequest;
      const filtered = mockSkills.filter(
        (skill) =>
          !skill.projectId ||
          request.projectIds.length === 0 ||
          request.projectIds.includes(skill.projectId),
      );
      recordMockAudit("SKILL_SCAN", null, { count: filtered.length });
      return filtered.map(decoratedSkill) as T;
    }
    case "get_skill": {
      const skill = mockSkills.find((candidate) => candidate.id === args?.id);
      if (!skill) throw new Error("Skill 不存在或已被移动");
      return skillDetail(skill) as T;
    }
    case "read_skill_file":
      return mockedSkillFile(String(args?.id), String(args?.relativePath)) as T;
    case "import_skill": {
      await sleep(520);
      const request = (args?.request ?? {}) as ImportSkillRequest;
      const sourcePath = request.sourcePath.trim().replace(/[\\/]+$/, "");
      if (!sourcePath) throw new Error("请选择包含 SKILL.md 的本地目录");
      if (!request.targets.length) throw new Error("至少选择一个目标 Agent");
      const rawName = sourcePath.split(/[\\/]/).filter(Boolean).at(-1) ?? "imported-skill";
      const name = rawName
        .toLocaleLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "imported-skill";
      const operationId = Date.now().toString(36);
      const revisionId = `revision-${operationId}`;
      const logicalSkillId = `managed-${operationId}`;
      const bindings = request.targets.map((target, index) => {
        const project = target.projectId
          ? mockProjects.find((candidate) => candidate.id === target.projectId)
          : undefined;
        if (target.scopeKind === "project" && !project) {
          throw new Error("目标项目不存在，请重新选择当前项目");
        }
        const base = target.scopeKind === "user" ? "C:\\Users\\ExampleUser" : project!.rootPath;
        const suffix =
          target.agentType === "codex"
            ? ".agents\\skills"
            : target.agentType === "claude"
              ? ".claude\\skills"
              : ".cursor\\skills";
        const linkPath = `${base}\\${suffix}\\${name}`;
        if (mockSkills.some((skill) => skill.path.toLocaleLowerCase() === linkPath.toLocaleLowerCase())) {
          throw new Error(`部署目标已存在：${linkPath}`);
        }
        const locationId = `imported-${operationId}-${index}`;
        const manifest = `---\nname: ${name}\ndescription: 从 ${sourcePath} 导入的本地 Skill。\n---\n\n# ${rawName}\n\n此 Skill 由 Skills Manager 管理。`;
        skillReadmes[locationId] = manifest;
        mockSkills.push({
          id: locationId,
          name,
          displayName: rawName,
          description: `从 ${sourcePath} 导入的本地 Skill。`,
          agentType: target.agentType,
          scopeKind: target.scopeKind === "project" ? "repo" : "user",
          sourceKind: "local-import",
          path: linkPath,
          enabledState: "enabled",
          readOnly: true,
          managed: true,
          healthStatus: "healthy",
          riskStatus: "review",
          projectId: target.projectId ?? null,
          duplicateName: false,
          updatedAt: Math.floor(Date.now() / 1000),
        });
        return {
          id: `binding-${operationId}-${index}`,
          agentType: target.agentType,
          scopeKind: target.scopeKind,
          linkPath,
          linkMode: request.allowCopyFallback ? "copy" : "junction",
          healthStatus: "ok",
        };
      });
      recordMockAudit("SKILL_IMPORT", logicalSkillId, { targets: bindings.length });
      return {
        skillId: logicalSkillId,
        revisionId,
        name,
        treeHash: await sha256Text(`${sourcePath}:${operationId}`),
        bindings,
      } as T;
    }
    case "set_skill_enabled": {
      const id = String(args?.locationId ?? "");
      const skill = mockSkills.find((candidate) => candidate.id === id);
      if (!skill) throw new Error("Skill 位置不存在，请先重新扫描");
      if (skill.agentType !== "codex" || skill.scopeKind === "plugin") {
        throw new Error("该来源不支持独立启用或禁用");
      }
      skill.enabledState = Boolean(args?.enabled) ? "enabled" : "disabled";
      skill.updatedAt = Math.floor(Date.now() / 1000);
      recordMockAudit("SKILL_ENABLE", id, { enabled: Boolean(args?.enabled) });
      return undefined as T;
    }
    case "write_skill_file": {
      await sleep(280);
      const request = (args?.request ?? {}) as WriteSkillFileRequest;
      const skill = mockSkills.find((candidate) => candidate.id === request.locationId);
      if (!skill) throw new Error("Skill 位置不存在，请先重新扫描");
      if (skill.readOnly) throw new Error("该 Skill 来源为只读");
      const current = mockedSkillFile(request.locationId, request.relativePath);
      const currentHash = await sha256Text(current);
      if (currentHash !== request.expectedHash) {
        throw new Error("Conflict: skill file changed outside the editor");
      }
      mockFileOverrides[request.locationId] ??= {};
      mockFileOverrides[request.locationId][request.relativePath] = request.content;
      if (request.relativePath === "SKILL.md") skillReadmes[request.locationId] = request.content;
      const updatedAt = Math.floor(Date.now() / 1000);
      skill.updatedAt = updatedAt;
      recordMockAudit("SKILL_FILE_WRITE", request.locationId, { path: request.relativePath });
      return {
        contentHash: await sha256Text(request.content),
        updatedAt,
      } as T;
    }
    case "scan_skill_security": {
      await sleep(640);
      const locationId = String(args?.locationId ?? "");
      const skill = mockSkills.find((candidate) => candidate.id === locationId);
      if (!skill) throw new Error("Skill 位置不存在，请先重新扫描");
      const risky = locationId === "skill-deploy-helper";
      const result: SecurityScanResult = risky
        ? {
            locationId,
            status: "risky",
            scannedAt: Math.floor(Date.now() / 1000),
            findings: [
              {
                id: "finding-secret-network",
                ruleId: "possible-secret-exfiltration",
                severity: "high",
                filePath: "scripts/deploy.ps1",
                line: 4,
                message: "网络操作与敏感环境变量访问出现在同一行，需要人工审阅。",
                evidenceRedacted: "Invoke-RestMethod -Uri $env:<redacted> -Method Post",
              },
              {
                id: "finding-external-process",
                ruleId: "external-process-control",
                severity: "medium",
                filePath: "scripts/deploy.ps1",
                line: 3,
                message: "该 Skill 会启动或控制外部进程。",
                evidenceRedacted: "<command> tauri build",
              },
            ],
            scannedFiles: 3,
            scannedBytes: 2134,
            skippedBinaryFiles: 0,
            skippedOversizedFiles: 0,
            skippedLinks: 0,
          }
        : {
            locationId,
            status: "safe",
            scannedAt: Math.floor(Date.now() / 1000),
            findings: [],
            scannedFiles: skillDetail(skill).files.length,
            scannedBytes: skillDetail(skill).files.reduce((total, file) => total + file.size, 0),
            skippedBinaryFiles: 0,
            skippedOversizedFiles: 0,
            skippedLinks: 0,
          };
      skill.riskStatus = result.status;
      skill.updatedAt = Math.floor(Date.now() / 1000);
      mockSecurityScans.set(locationId, result);
      recordMockAudit("SKILL_SECURITY_SCAN", locationId, {
        status: result.status,
        findings: result.findings.length,
        scannedFiles: result.scannedFiles,
      });
      return result as T;
    }
    case "get_skill_security_scan": {
      const locationId = String(args?.locationId ?? "");
      return (mockSecurityScans.get(locationId) ?? null) as T;
    }
    case "get_ai_description_settings":
      return { ...mockAiSettings } as T;
    case "update_ai_description_settings": {
      const request = (args?.request ?? {}) as UpdateAiDescriptionSettingsRequest;
      if (request.localEndpoint !== undefined) validateMockLocalEndpoint(request.localEndpoint);
      if (typeof request.localModel === "string" && !request.localModel.trim()) {
        throw new DesktopApiError("本机模型名称不能为空", "AI_NOT_CONFIGURED");
      }
      if (request.openaiModel !== undefined && !request.openaiModel.trim()) {
        throw new DesktopApiError("OpenAI 模型名称不能为空", "AI_NOT_CONFIGURED");
      }
      if (request.compatibleBaseUrl !== undefined) {
        normalizeCompatibleBaseUrl(request.compatibleBaseUrl);
      }
      if (request.compatibleModel !== undefined && !request.compatibleModel.trim()) {
        throw new DesktopApiError("OpenAI-compatible 模型名称不能为空", "AI_NOT_CONFIGURED");
      }
      mockAiSettings = {
        ...mockAiSettings,
        ...request,
        localEndpoint: request.localEndpoint?.trim() ?? mockAiSettings.localEndpoint,
        localModel:
          request.localModel === undefined
            ? mockAiSettings.localModel
            : request.localModel?.trim() ?? null,
        openaiModel: request.openaiModel?.trim() ?? mockAiSettings.openaiModel,
        compatibleBaseUrl: request.compatibleBaseUrl === undefined
          ? mockAiSettings.compatibleBaseUrl
          : normalizeCompatibleBaseUrl(request.compatibleBaseUrl),
        compatibleModel:
          request.compatibleModel?.trim() ?? mockAiSettings.compatibleModel,
        openaiKeyState: mockOpenAiSecretConfigured ? "stored" : "missing",
        compatibleApiKeyConfigured: mockCompatibleSecretConfigured,
      };
      return { ...mockAiSettings } as T;
    }
    case "set_ai_provider_secret": {
      const secret = String(args?.secret ?? "").trim();
      if (!secret) throw new DesktopApiError("API Key 不能为空", "AI_AUTH_ERROR");
      const provider = String(args?.provider ?? "openai");
      if (provider === "compatible") mockCompatibleSecretConfigured = true;
      else if (provider === "openai") mockOpenAiSecretConfigured = true;
      else throw new DesktopApiError("不支持为此 Provider 保存密钥", "AI_NOT_CONFIGURED");
      mockAiSettings = {
        ...mockAiSettings,
        openaiKeyState: mockOpenAiSecretConfigured ? "stored" : "missing",
        compatibleApiKeyConfigured: mockCompatibleSecretConfigured,
      };
      return { ...mockAiSettings } as T;
    }
    case "delete_ai_provider_secret": {
      const provider = String(args?.provider ?? "openai");
      if (provider === "compatible") mockCompatibleSecretConfigured = false;
      else if (provider === "openai") mockOpenAiSecretConfigured = false;
      else throw new DesktopApiError("不支持为此 Provider 删除密钥", "AI_NOT_CONFIGURED");
      mockAiSettings = {
        ...mockAiSettings,
        openaiKeyState: mockOpenAiSecretConfigured ? "stored" : "missing",
        compatibleApiKeyConfigured: mockCompatibleSecretConfigured,
      };
      return { ...mockAiSettings } as T;
    }
    case "detect_local_ai_providers":
      requireMockAiEnabled("local");
      return ([
        {
          id: "ollama",
          name: "Ollama",
          endpoint: "http://127.0.0.1:11434",
          available: true,
          models: ["qwen3:4b", "qwen2.5:7b"],
        },
        {
          id: "lmStudio",
          name: "LM Studio",
          endpoint: "http://127.0.0.1:1234",
          available: false,
          models: [],
          error: "未检测到正在运行的服务",
        },
      ] satisfies LocalAiProvider[]) as T;
    case "test_ai_description_provider": {
      const provider = mockAiSettings.provider;
      requireMockAiEnabled(provider);
      const model =
        provider === "openai"
          ? mockAiSettings.openaiModel
          : provider === "compatible"
            ? mockAiSettings.compatibleModel
            : mockAiSettings.localModel;
      if (!model?.trim()) throw new DesktopApiError("模型名称不能为空", "AI_NOT_CONFIGURED");
      return ({
        ok: true,
        provider,
        model,
        latencyMs: provider === "local" ? 18 : 126,
        message:
          provider === "local"
            ? "本机模型服务连接正常"
            : provider === "compatible"
              ? "OpenAI-compatible API 连接正常"
              : "OpenAI 连接正常",
      } satisfies AiProviderTestResult) as T;
    }
    case "generate_skill_description": {
      const request = (args?.request ?? {}) as GenerateSkillDescriptionRequest;
      const skill = mockSkills.find((candidate) => candidate.id === request.locationId);
      if (!skill) throw new DesktopApiError("Skill 不存在或已被移动", "SKILL_NOT_FOUND");
      const provider = mockAiSettings.provider;
      requireMockAiEnabled(provider);
      const mode = request.mode;
      const existing = mockLocalizations.get(mockLocalizationKey(skill.id, mode));
      if (existing && !request.force) return existing as T;
      if (containsChinese(skill.description) && !request.force) {
        return ({
          locale: "zh-CN",
          status: "notNeeded",
        } satisfies SkillDescriptionLocalization) as T;
      }
      if (
        provider !== "local" &&
        !skill.description.trim() &&
        !request.allowRemoteManifestExcerpt
      ) {
        throw new DesktopApiError(
          "该 Skill 缺少 description，需要确认后才能发送 SKILL.md 摘要",
          "AI_BODY_CONFIRM_REQUIRED",
        );
      }
      if (provider !== "local") {
        assertMockSkillSafeForRemote(skill);
        const source = !skill.description.trim() && request.allowRemoteManifestExcerpt
          ? mockedSkillFile(skill.id, "SKILL.md")
          : skill.description;
        const sourceScope = !skill.description.trim() && request.allowRemoteManifestExcerpt
          ? "manifestExcerpt"
          : "description";
        const expected = await sha256Text(
          mockRemoteConfirmationPayload(skill, request.mode, sourceScope, source),
        );
        if (!request.expectedSourceHash) {
          throw new DesktopApiError(
            "远程生成需要与当前源文本绑定的确认",
            "AI_REMOTE_CONFIRM_REQUIRED",
          );
        }
        if (request.expectedSourceHash !== expected) {
          throw new DesktopApiError("Skill 源文本已变化", "SOURCE_CHANGED", true);
        }
      }
      const started = Date.now();
      const localization = createMockLocalization(skill, mode, provider);
      recordMockAudit("SKILL_DESCRIPTION_GENERATE", skill.id, {
        provider,
        model: localization.modelId,
        mode,
        durationMs: Date.now() - started,
        inputCharacters: skill.description.length,
        cached: false,
        result: "success",
      });
      return localization as T;
    }
    case "set_manual_skill_description": {
      const request = (args?.request ?? {}) as SetManualSkillDescriptionRequest;
      const skill = mockSkills.find((candidate) => candidate.id === request.locationId);
      if (!skill) throw new DesktopApiError("Skill 不存在或已被移动", "SKILL_NOT_FOUND");
      const text = request.text.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
      if (!text) throw new DesktopApiError("中文简介不能为空", "AI_RESPONSE_INVALID");
      if (text.length > 100) {
        throw new DesktopApiError("中文简介不能超过 100 个字符", "AI_RESPONSE_INVALID");
      }
      const localization: SkillDescriptionLocalization = {
        locale: "zh-CN",
        status: "ready",
        text,
        mode: "manual",
        origin: "manual",
        sourceScope: "description",
        generatedAt: Math.floor(Date.now() / 1000),
      };
      mockLocalizations.set(mockLocalizationKey(skill.id, "manual"), localization);
      recordMockAudit("SKILL_DESCRIPTION_MANUAL", skill.id, {
        mode: "manual",
        inputCharacters: text.length,
        result: "success",
      });
      return localization as T;
    }
    case "clear_skill_description": {
      const request = (args?.request ?? {}) as ClearSkillDescriptionRequest;
      if (request.mode) {
        mockLocalizations.delete(mockLocalizationKey(request.locationId, request.mode));
      } else {
        for (const mode of ["manual", "translate", "summarize"] as const) {
          mockLocalizations.delete(mockLocalizationKey(request.locationId, mode));
        }
      }
      recordMockAudit("SKILL_DESCRIPTION_CLEAR", request.locationId, {
        mode: request.mode ?? "all",
      });
      return undefined as T;
    }
    case "start_skill_description_job": {
      const request = (args?.request ?? {}) as SkillDescriptionJobRequest;
      requireMockAiEnabled();
      const active = [...mockDescriptionJobs.values()].find(({ job }) =>
        job.status === "queued" || job.status === "running",
      );
      if (active) {
        throw new DesktopApiError("已有中文简介批量任务正在运行", "AI_ALREADY_RUNNING");
      }
      const availableIds = new Set(mockSkills.map((skill) => skill.id));
      const selected = [...new Set(request.locationIds)].filter((id) => availableIds.has(id));
      const limit = mockAiSettings.provider === "local" ? 200 : 50;
      if (selected.length > limit) {
        throw new DesktopApiError(`单次批量任务最多处理 ${limit} 个 Skills`, "AI_RESPONSE_INVALID");
      }
      if (mockAiSettings.provider !== "local") {
        for (const locationId of selected) {
          const skill = mockSkills.find((candidate) => candidate.id === locationId);
          if (!skill?.description.trim()) continue;
          const expected = await sha256Text(
            mockRemoteConfirmationPayload(skill, request.mode, "description", skill.description),
          );
          if (request.expectedSourceHashes?.[locationId] !== expected) {
            throw new DesktopApiError("远程确认对应的 Skill 源文本已变化", "SOURCE_CHANGED", true);
          }
        }
      }
      const timestamp = Math.floor(Date.now() / 1000);
      const job: SkillDescriptionJob = {
        id: `description-job-${Date.now().toString(36)}`,
        targetLocale: request.targetLocale,
        mode: request.mode,
        force: request.force,
        status: "queued",
        total: selected.length,
        completed: 0,
        succeeded: 0,
        skipped: 0,
        failed: 0,
        currentLocationId: selected[0] ?? null,
        failures: [],
        startedAt: timestamp,
        finishedAt: selected.length === 0 ? timestamp : null,
      };
      if (selected.length === 0) job.status = "completed";
      mockDescriptionJobs.set(job.id, {
        job,
        pendingLocationIds: selected,
        force: request.force,
        provider: mockAiSettings.provider,
        mode: request.mode,
      });
      return { ...job, failures: [...job.failures] } as T;
    }
    case "get_skill_description_job": {
      const requestedId = String(args?.jobId ?? "");
      const state = requestedId
        ? mockDescriptionJobs.get(requestedId)
        : [...mockDescriptionJobs.values()].at(-1);
      if (!state) return null as T;
      advanceMockDescriptionJob(state);
      return { ...state.job, failures: [...state.job.failures] } as T;
    }
    case "cancel_skill_description_job": {
      const state = mockDescriptionJobs.get(String(args?.jobId ?? ""));
      if (!state) throw new DesktopApiError("批量任务不存在", "JOB_NOT_FOUND");
      if (state.job.status === "queued" || state.job.status === "running") {
        state.pendingLocationIds = [];
        state.job.status = "cancelled";
        state.job.currentLocationId = null;
        state.job.finishedAt = Math.floor(Date.now() / 1000);
      }
      return { ...state.job, failures: [...state.job.failures] } as T;
    }
    case "remove_managed_binding": {
      const locationId = String(args?.locationId ?? "");
      const index = mockSkills.findIndex((candidate) => candidate.id === locationId);
      if (index < 0) throw new Error("Skill 位置不存在，请先重新扫描");
      if (!mockSkills[index].managed) throw new Error("只能移除由 Skills Manager 托管的部署");
      const [removed] = mockSkills.splice(index, 1);
      delete skillReadmes[locationId];
      mockSecurityScans.delete(locationId);
      recordMockAudit("SKILL_UNINSTALL", locationId, { path: removed.path });
      return undefined as T;
    }
    case "list_audit_logs": {
      const limit = Math.max(1, Math.min(500, Number(args?.limit ?? 100)));
      return mockAuditLogs.slice(0, limit) as T;
    }
    default:
      throw new Error(`Mock 尚未实现命令：${command}`);
  }
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return isTauriRuntime ? await invoke<T>(command, args) : await mockInvoke<T>(command, args);
  } catch (error) {
    throw toDesktopApiError(error);
  }
}

function errorRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function toDesktopApiError(error: unknown): DesktopApiError {
  if (error instanceof DesktopApiError) return error;

  let candidate: unknown = error;
  if (typeof error === "string" && error.trim().startsWith("{")) {
    try {
      candidate = JSON.parse(error) as unknown;
    } catch {
      candidate = error;
    }
  }

  const record = errorRecord(candidate);
  const message =
    (record && typeof record.message === "string" && record.message) ||
    (candidate instanceof Error ? candidate.message : null) ||
    (typeof candidate === "string" ? candidate : null) ||
    "本地服务请求失败";
  const code =
    record && typeof record.code === "string" ? record.code : "DESKTOP_API_ERROR";
  const retryable = record?.retryable === true;
  return new DesktopApiError(message, code, retryable);
}

export const desktopApi = {
  getCapabilities: () => call<CapabilityInfo>("get_capabilities"),
  listProjects: () => call<Project[]>("list_projects"),
  addProject: (path: string, trusted: boolean) =>
    call<Project>("add_project", { path, trusted }),
  removeProject: (id: string) => call<void>("remove_project", { id }),
  indexSessions: () => call<number>("index_sessions"),
  searchSessions: (request: SessionSearchRequest) =>
    call<SessionSummary[]>("search_sessions", { request }),
  getSession: (id: string) => call<SessionDetail>("get_session", { id }),
  scanSkills: (request: SkillScanRequest) =>
    call<SkillSummary[]>("scan_skills", { request }),
  getSkill: (id: string) => call<SkillDetail>("get_skill", { id }),
  readSkillFile: (id: string, relativePath: string) =>
    call<string>("read_skill_file", { id, relativePath }),
  importSkill: (request: ImportSkillRequest) =>
    call<ImportSkillResult>("import_skill", { request }),
  removeManagedBinding: (locationId: string) =>
    call<void>("remove_managed_binding", { locationId }),
  setSkillEnabled: (locationId: string, enabled: boolean) =>
    call<void>("set_skill_enabled", { locationId, enabled }),
  writeSkillFile: (request: WriteSkillFileRequest) =>
    call<WriteSkillFileResult>("write_skill_file", { request }),
  scanSkillSecurity: (locationId: string) =>
    call<SecurityScanResult>("scan_skill_security", { locationId }),
  getSkillSecurityScan: (locationId: string) =>
    call<SecurityScanResult | null>("get_skill_security_scan", { locationId }),
  getAiDescriptionSettings: () =>
    call<AiDescriptionSettings>("get_ai_description_settings"),
  updateAiDescriptionSettings: (request: UpdateAiDescriptionSettingsRequest) =>
    call<AiDescriptionSettings>("update_ai_description_settings", { request }),
  setAiProviderSecret: (
    secret: string,
    provider: Exclude<AiDescriptionProviderId, "local"> = "openai",
  ) => call<AiDescriptionSettings>("set_ai_provider_secret", { provider, secret }),
  deleteAiProviderSecret: (
    provider: Exclude<AiDescriptionProviderId, "local"> = "openai",
  ) => call<AiDescriptionSettings>("delete_ai_provider_secret", { provider }),
  detectLocalAiProviders: () =>
    call<LocalAiProvider[]>("detect_local_ai_providers"),
  testAiDescriptionProvider: () =>
    call<AiProviderTestResult>("test_ai_description_provider"),
  generateSkillDescription: (request: GenerateSkillDescriptionRequest) =>
    call<SkillDescriptionLocalization>("generate_skill_description", { request }),
  setManualSkillDescription: (request: SetManualSkillDescriptionRequest) =>
    call<SkillDescriptionLocalization>("set_manual_skill_description", { request }),
  clearSkillDescription: (request: ClearSkillDescriptionRequest) =>
    call<void>("clear_skill_description", { request }),
  startSkillDescriptionJob: (request: SkillDescriptionJobRequest) =>
    call<SkillDescriptionJob>("start_skill_description_job", { request }),
  getSkillDescriptionJob: (jobId?: string) =>
    call<SkillDescriptionJob | null>("get_skill_description_job", { jobId }),
  cancelSkillDescriptionJob: (jobId: string) =>
    call<SkillDescriptionJob>("cancel_skill_description_job", { jobId }),
  listAuditLogs: (limit = 100) =>
    call<AuditLogEntry[]>("list_audit_logs", { limit }),
};
