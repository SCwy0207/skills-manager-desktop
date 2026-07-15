import { describe, expect, it, vi } from "vitest";

import { skillsMessages } from "../i18n/messages/skills";
import { normalizeCompatibleBaseUrl, normalizeCompatibleEndpoint } from "../lib/ipc";
import type { AiDescriptionSettings, SkillSummary } from "../types";
import {
  AiSettingsSubmissionError,
  batchForceRequired,
  buildBatchReviewItems,
  defaultBatchSelection,
  eligibleBatchSkills,
  mergeCredentialStatus,
  remoteConfirmationPayload,
  remoteProviderDomain,
  saveAiSettingsAndOptionalSecret,
} from "./AiDescriptionUi";
import { getSkillDisplayDescription } from "./SkillsView";

function skill(overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    id: "skill-test",
    name: "test-skill",
    displayName: "Test Skill",
    description: "Create release notes from Git history.",
    agentType: "codex",
    scopeKind: "user",
    sourceKind: "filesystem",
    path: "C:\\skills\\test-skill",
    enabledState: "enabled",
    readOnly: false,
    managed: false,
    healthStatus: "healthy",
    riskStatus: "safe",
    duplicateName: false,
    updatedAt: 1,
    ...overrides,
  };
}

function aiSettings(overrides: Partial<AiDescriptionSettings> = {}): AiDescriptionSettings {
  return {
    enabled: true,
    provider: "local",
    localEndpoint: "http://127.0.0.1:11434",
    localModel: "qwen3:4b",
    openaiModel: "gpt-5.6-luna",
    compatibleBaseUrl: "https://api.example.com/v1",
    compatibleModel: "custom-model",
    compatibleApiKeyConfigured: false,
    defaultMode: "summarize",
    openaiKeyState: "missing",
    localSecretStored: false,
    ...overrides,
  };
}

describe("AI Skill descriptions", () => {
  it("prefers a local Chinese description without overwriting the author text", () => {
    const original = "Create release notes from Git history.";
    const candidate = skill({
      description: original,
      descriptionLocalization: {
        locale: "zh-CN",
        status: "ready",
        text: "根据 Git 历史生成结构清晰的发布说明。",
        mode: "summarize",
        origin: "localModel",
      },
    });

    expect(getSkillDisplayDescription(candidate)).toBe("根据 Git 历史生成结构清晰的发布说明。");
    expect(candidate.description).toBe(original);
  });

  it("only queues English Skills that are missing or stale by default", () => {
    const missing = skill({ id: "missing" });
    const stale = skill({
      id: "stale",
      descriptionLocalization: { locale: "zh-CN", status: "stale", text: "旧简介" },
    });
    const ready = skill({
      id: "ready",
      descriptionLocalization: { locale: "zh-CN", status: "ready", text: "有效简介" },
    });
    const alreadyChinese = skill({ id: "chinese", description: "创建和维护发布说明。" });
    const mixedEnglish = skill({ id: "mixed", description: "Create APIs with 中文 labels and English documentation." });
    const manual = skill({
      id: "manual",
      descriptionLocalization: {
        locale: "zh-CN",
        status: "ready",
        text: "手工维护的中文简介。",
        mode: "manual",
        origin: "manual",
      },
    });

    expect(eligibleBatchSkills([missing, stale, ready, alreadyChinese, mixedEnglish, manual], false).map((item) => item.id)).toEqual(["missing", "stale", "mixed"]);
    expect(eligibleBatchSkills([ready, alreadyChinese, manual], true).map((item) => item.id)).toEqual(["ready", "chinese"]);
  });

  it("classifies each Skill against the selected generation mode", () => {
    const candidate = skill({
      descriptionLocalization: {
        locale: "zh-CN",
        status: "ready",
        text: "当前显示的是能力总结。",
        mode: "summarize",
      },
      descriptionLocalizations: [
        {
          locale: "zh-CN",
          status: "ready",
          text: "当前显示的是能力总结。",
          mode: "summarize",
        },
        {
          locale: "zh-CN",
          status: "stale",
          text: "这是一条过期翻译。",
          mode: "translate",
        },
      ],
    });

    expect(buildBatchReviewItems([candidate], "summarize")[0]).toMatchObject({
      category: "translated",
      reason: "ready",
      selectedByDefault: false,
      requiresForce: true,
    });
    expect(buildBatchReviewItems([candidate], "translate")[0]).toMatchObject({
      category: "needs",
      reason: "stale",
      selectedByDefault: true,
      requiresForce: false,
    });
  });

  it("prioritises a previous failure and defaults only actionable recommendations", () => {
    const failedWithOldResult = skill({
      id: "failed-ready",
      descriptionLocalizations: [{
        locale: "zh-CN",
        status: "ready",
        text: "上一次成功生成的翻译。",
        mode: "translate",
      }],
    });
    const missing = skill({ id: "missing" });
    const stale = skill({
      id: "stale",
      descriptionLocalizations: [{
        locale: "zh-CN",
        status: "stale",
        text: "已过期。",
        mode: "translate",
      }],
    });
    const ready = skill({
      id: "ready",
      descriptionLocalizations: [{
        locale: "zh-CN",
        status: "ready",
        text: "有效翻译。",
        mode: "translate",
      }],
    });
    const manual = skill({
      id: "manual",
      descriptionLocalizations: [{
        locale: "zh-CN",
        status: "ready",
        text: "人工简介。",
        mode: "manual",
        origin: "manual",
      }],
    });
    const nativeChinese = skill({ id: "native", description: "作者已经提供中文简介。" });
    const noSource = skill({ id: "no-source", description: "" });
    const items = buildBatchReviewItems(
      [failedWithOldResult, missing, stale, ready, manual, nativeChinese, noSource],
      "translate",
      [{ locationId: "failed-ready", code: "AI_RESPONSE_INVALID", message: "invalid schema" }],
    );

    expect(items.map(({ skill: itemSkill, category, reason }) => [itemSkill.id, category, reason])).toEqual([
      ["failed-ready", "retry", "failed"],
      ["missing", "needs", "missing"],
      ["stale", "needs", "stale"],
      ["ready", "translated", "ready"],
      ["manual", "protected", "manual"],
      ["native", "protected", "notNeeded"],
      ["no-source", "protected", "noSource"],
    ]);

    const recommended = defaultBatchSelection(items);
    expect([...recommended]).toEqual(["failed-ready", "missing", "stale"]);
    expect([...defaultBatchSelection(items, "failures")]).toEqual(["failed-ready"]);
    expect(batchForceRequired(items, recommended)).toBe(true);
    expect(batchForceRequired(items, new Set(["missing", "stale"]))).toBe(false);
    expect(batchForceRequired(items, new Set(["ready"]))).toBe(true);
  });

  it("protects native Chinese and applies the remote no-body policy before retry", () => {
    const nativeWithHistory = skill({
      id: "native-history",
      description: "作者已经改为中文简介。",
      descriptionLocalizations: [{
        locale: "zh-CN",
        status: "ready",
        text: "旧模型结果。",
        mode: "summarize",
      }],
    });
    const empty = skill({ id: "empty", description: "" });
    const failure = [{ locationId: "native-history", code: "AI_TIMEOUT", message: "timeout" }];

    expect(buildBatchReviewItems([nativeWithHistory], "summarize", failure)[0]).toMatchObject({
      category: "protected",
      reason: "notNeeded",
      selectable: false,
    });
    expect(buildBatchReviewItems([empty], "summarize", [], false)[0]).toMatchObject({
      category: "needs",
      reason: "missing",
      selectedByDefault: true,
    });
    expect(buildBatchReviewItems([empty], "summarize", [], true)[0]).toMatchObject({
      category: "protected",
      reason: "remoteBodyBlocked",
      selectedByDefault: false,
    });
  });

  it("keeps the Skills message catalogue complete across all three locales", () => {
    const simplifiedKeys = Object.keys(skillsMessages["zh-CN"]).sort();
    expect(Object.keys(skillsMessages["zh-TW"]).sort()).toEqual(simplifiedKeys);
    expect(Object.keys(skillsMessages["en-GB"]).sort()).toEqual(simplifiedKeys);
    expect(skillsMessages["zh-TW"]["skills.import.action"]).toBe("匯入");
    expect(skillsMessages["en-GB"]["skills.ai.settingsDescription"]).toContain("summarise");
    expect(skillsMessages["en-GB"]["skills.batch.cancelled"]).toContain("cancelled");
    expect(skillsMessages["zh-CN"]["skills.ai.compatible.title"]).toBe("通用 API");
    expect(skillsMessages["zh-TW"]["skills.ai.compatible.subtitle"]).toBe("OpenAI 相容");
    expect(skillsMessages["en-GB"]["skills.ai.compatible.title"]).toBe("Custom API");
  });

  it("normalises compatible endpoints exactly as the confirmation contract expects", () => {
    expect(normalizeCompatibleBaseUrl("https://API.EXAMPLE.com/")).toBe(
      "https://api.example.com",
    );
    expect(normalizeCompatibleBaseUrl("https://api.example.com/v1/")).toBe(
      "https://api.example.com/v1",
    );
    expect(normalizeCompatibleEndpoint("https://API.EXAMPLE.com")).toBe(
      "https://api.example.com/chat/completions",
    );
    expect(normalizeCompatibleEndpoint("https://api.example.com/v1/")).toBe(
      "https://api.example.com/v1/chat/completions",
    );
    expect(normalizeCompatibleEndpoint("https://api.example.com/api/v1")).toBe(
      "https://api.example.com/api/v1/chat/completions",
    );
    expect(normalizeCompatibleEndpoint("https://api.example.com/custom/chat/completions/")).toBe(
      "https://api.example.com/custom/chat/completions",
    );
    for (const invalid of [
      "http://api.example.com/v1",
      "https://user:pass@api.example.com/v1",
      "https://api.example.com/v1?key=value",
      "https://api.example.com/v1?",
      "https://api.example.com/v1#fragment",
      "https://api.example.com/v1#",
      "https://localhost:8443/v1",
      "https://localhost.:8443/v1",
      "https://models.localhost/v1",
      "https://127.0.0.2/v1",
      "https://[::1]/v1",
      "https://[::ffff:127.0.0.1]:8443/v1",
      "https://[::ffff:7fff:ffff]/v1",
    ]) {
      expect(() => normalizeCompatibleEndpoint(invalid), invalid).toThrow();
    }
  });

  it("binds compatible confirmation to provider, model and canonical endpoint", () => {
    const compatible = aiSettings({ provider: "compatible" });
    expect(remoteConfirmationPayload(
      compatible,
      "summarize",
      "sample",
      "description",
      "English source",
    ).split("\u0000")).toEqual([
      "skill-description-confirmation-v1",
      "compatible",
      "custom-model",
      "https://api.example.com/v1/chat/completions",
      "zh-CN",
      "summarize",
      "sample",
      "description",
      "English source",
    ]);
    expect(remoteProviderDomain(compatible)).toBe("api.example.com");

    const openai = aiSettings({ provider: "openai" });
    expect(remoteConfirmationPayload(
      openai,
      "summarize",
      "sample",
      "description",
      "English source",
    ).split("\u0000")).toEqual([
      "skill-description-confirmation-v1",
      "openai",
      "gpt-5.6-luna",
      "zh-CN",
      "summarize",
      "sample",
      "description",
      "English source",
    ]);
  });

  it("preserves unsaved compatible fields when a credential status changes", () => {
    const draft = aiSettings({
      provider: "compatible",
      compatibleBaseUrl: "https://draft.example/v1",
      compatibleModel: "draft-model",
    });
    const staleBackendResult = aiSettings({
      provider: "openai",
      compatibleBaseUrl: "https://saved.example/v1",
      compatibleModel: "saved-model",
      compatibleApiKeyConfigured: true,
    });
    expect(mergeCredentialStatus(draft, staleBackendResult)).toMatchObject({
      provider: "compatible",
      compatibleBaseUrl: "https://draft.example/v1",
      compatibleModel: "draft-model",
      compatibleApiKeyConfigured: true,
    });
  });

  it("saves settings and a pending compatible credential through one action", async () => {
    const settings = aiSettings({ provider: "compatible" });
    const settingsResult = aiSettings({
      provider: "compatible",
      compatibleBaseUrl: "https://api.example.com/v1/chat/completions",
    });
    const credentialResult = { ...settingsResult, compatibleApiKeyConfigured: true };
    const order: string[] = [];
    const updateAiDescriptionSettings = vi.fn(async () => {
      order.push("settings");
      return settingsResult;
    });
    const setAiProviderSecret = vi.fn(async () => {
      order.push("credential");
      return credentialResult;
    });

    await expect(saveAiSettingsAndOptionalSecret(
      settings,
      "  pending-secret  ",
      { updateAiDescriptionSettings, setAiProviderSecret },
    )).resolves.toEqual({ settings: credentialResult, credentialSaved: true });
    expect(order).toEqual(["settings", "credential"]);
    expect(setAiProviderSecret).toHaveBeenCalledWith("pending-secret", "compatible");
  });

  it("reports partial credential failures without retaining the submitted secret", async () => {
    const settings = aiSettings({ provider: "compatible" });
    const savedSettings = { ...settings, compatibleBaseUrl: "https://api.example.com/chat/completions" };
    const updateAiDescriptionSettings = vi.fn(async () => savedSettings);
    const setAiProviderSecret = vi.fn(async () => {
      throw new Error("vault rejected pending-secret");
    });

    const error = await saveAiSettingsAndOptionalSecret(
      settings,
      "pending-secret",
      { updateAiDescriptionSettings, setAiProviderSecret },
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AiSettingsSubmissionError);
    expect(error).toMatchObject({ stage: "credential", savedSettings });
    expect((error as Error).message).not.toContain("pending-secret");
  });
});
