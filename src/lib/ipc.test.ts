import { describe, expect, it } from "vitest";

import { sha256Text } from "./hash";
import {
  DesktopApiError,
  desktopApi,
  isTauriRuntime,
  normalizeCompatibleEndpoint,
} from "./ipc";

function syntheticProviderToken(label: string) {
  return ["s", "k", "-", label, "-synthetic-fixture-value"].join("");
}

describe("browser IPC mock management", () => {
  it("保留已净化的 Provider 诊断，但不会回显密钥或端点", () => {
    const diagnostic = new DesktopApiError(
      "AI provider returned an invalid response: provider rejected the request with HTTP 400: response_format type json_schema is invalid",
      "AI_RESPONSE_INVALID",
    );
    expect(diagnostic.detail).toContain("HTTP 400");
    expect(diagnostic.message).toContain("json_schema");

    const rejectedSecret = syntheticProviderToken("diagnostic");
    const sensitive = new DesktopApiError(
      `AI provider returned an invalid response: rejected ${rejectedSecret}`,
      "AI_RESPONSE_INVALID",
    );
    expect(sensitive.detail).toBeUndefined();
    expect(sensitive.message).not.toContain(rejectedSecret);

    const endpoint = new DesktopApiError(
      "AI provider returned an invalid response: request to https://private.example/v1 failed",
      "AI_RESPONSE_INVALID",
    );
    expect(endpoint.message).toContain("[endpoint redacted]");
    expect(endpoint.message).not.toContain("private.example");
  });

  it("使用内容哈希保存可写 Skill 文件", async () => {
    expect(isTauriRuntime).toBe(false);
    const skills = await desktopApi.scanSkills({
      projectIds: ["project-control-center"],
      includePluginCache: true,
    });
    const skill = skills.find((candidate) => candidate.id === "skill-release-notes");
    expect(skill?.readOnly).toBe(false);

    const original = await desktopApi.readSkillFile(skill!.id, "SKILL.md");
    const content = `${original}\n\n测试保存。`;
    const result = await desktopApi.writeSkillFile({
      locationId: skill!.id,
      relativePath: "SKILL.md",
      content,
      expectedHash: await sha256Text(original),
    });

    expect(result.contentHash).toBe(await sha256Text(content));
    await expect(desktopApi.readSkillFile(skill!.id, "SKILL.md")).resolves.toBe(content);
  });

  it("拒绝过期内容哈希，保留并发冲突", async () => {
    await expect(
      desktopApi.writeSkillFile({
        locationId: "skill-release-notes",
        relativePath: "SKILL.md",
        content: "outdated",
        expectedHash: "0".repeat(64),
      }),
    ).rejects.toThrow(/changed outside/i);
  });

  it("安全扫描 mock 同时覆盖无发现与高风险结果", async () => {
    const safe = await desktopApi.scanSkillSecurity("skill-openai-docs");
    const risky = await desktopApi.scanSkillSecurity("skill-deploy-helper");

    expect(safe.status).toBe("safe");
    expect(safe.findings).toHaveLength(0);
    expect(risky.status).toBe("risky");
    expect(risky.findings.some((finding) => finding.severity === "high")).toBe(true);
    expect(risky.findings[0].evidenceRedacted).toContain("<redacted>");
    await expect(desktopApi.getSkillSecurityScan("skill-openai-docs")).resolves.toEqual(safe);
    await expect(desktopApi.getSkillSecurityScan("skill-deploy-helper")).resolves.toEqual(risky);
  });

  it("可移除托管部署并保留非托管库存", async () => {
    const imported = await desktopApi.importSkill({
      sourcePath: `D:\\Skills\\remove-fixture-${Date.now()}`,
      targets: [{ agentType: "cursor", scopeKind: "user" }],
      allowCopyFallback: false,
    });
    const skills = await desktopApi.scanSkills({ projectIds: [], includePluginCache: false });
    const deployed = skills.find((skill) => skill.path === imported.bindings[0].linkPath);
    expect(deployed?.managed).toBe(true);

    await desktopApi.removeManagedBinding(deployed!.id);
    await expect(desktopApi.getSkill(deployed!.id)).rejects.toThrow(/不存在/);
    await expect(desktopApi.removeManagedBinding("skill-openai-docs")).rejects.toThrow(/托管/);
  });

  it("AI 中文简介默认关闭，并只检测回环本机 Provider", async () => {
    const settings = await desktopApi.getAiDescriptionSettings();
    expect(settings.enabled).toBe(false);
    expect(settings.provider).toBe("local");
    expect(settings.openaiKeyState).toBe("missing");

    await expect(desktopApi.detectLocalAiProviders()).rejects.toMatchObject({
      code: "AI_NOT_CONFIGURED",
    });
    await desktopApi.updateAiDescriptionSettings({ enabled: true });
    const providers = await desktopApi.detectLocalAiProviders();
    expect(providers.map((provider) => provider.id)).toEqual(["ollama", "lmStudio"]);
    expect(providers.every((provider) => /^http:\/\/127\.0\.0\.1:/u.test(provider.endpoint))).toBe(true);

    await expect(
      desktopApi.updateAiDescriptionSettings({ localEndpoint: "http://localhost:11434" }),
    ).rejects.toMatchObject({
      code: "AI_NOT_CONFIGURED",
      retryable: false,
    });
  });

  it("保留 Provider 认证错误的 code 与 retryable 字段", async () => {
    await desktopApi.deleteAiProviderSecret();
    await desktopApi.updateAiDescriptionSettings({
      enabled: true,
      provider: "openai",
      openaiModel: "gpt-test-mini",
    });

    try {
      await desktopApi.testAiDescriptionProvider();
      throw new Error("expected provider test to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(DesktopApiError);
      expect(error).toMatchObject({ code: "AI_AUTH_ERROR", retryable: false });
    }

    const stored = await desktopApi.setAiProviderSecret(syntheticProviderToken("browser-mock"));
    expect(stored.openaiKeyState).toBe("stored");
    await expect(desktopApi.testAiDescriptionProvider()).resolves.toMatchObject({
      ok: true,
      provider: "openai",
      model: "gpt-test-mini",
    });
    const cleared = await desktopApi.deleteAiProviderSecret();
    expect(cleared.openaiKeyState).toBe("missing");
  });

  it("完整模拟通用 OpenAI-compatible Provider，且凭据与 OpenAI 相互隔离", async () => {
    await desktopApi.deleteAiProviderSecret("compatible");
    await desktopApi.deleteAiProviderSecret("openai");
    const configured = await desktopApi.updateAiDescriptionSettings({
      enabled: true,
      provider: "compatible",
      compatibleBaseUrl: "https://api.example.com/api/v1/chat/completions",
      compatibleModel: "compatible-test-model",
    });
    expect(configured).toMatchObject({
      provider: "compatible",
      compatibleBaseUrl: "https://api.example.com/api/v1/chat/completions",
      compatibleModel: "compatible-test-model",
      compatibleApiKeyConfigured: false,
      openaiKeyState: "missing",
    });
    await expect(desktopApi.testAiDescriptionProvider()).rejects.toMatchObject({
      code: "AI_NOT_CONFIGURED",
      retryable: false,
    });

    const stored = await desktopApi.setAiProviderSecret(
      "compatible-browser-mock-secret",
      "compatible",
    );
    expect(stored.compatibleApiKeyConfigured).toBe(true);
    expect(stored.openaiKeyState).toBe("missing");
    await expect(desktopApi.testAiDescriptionProvider()).resolves.toMatchObject({
      ok: true,
      provider: "compatible",
      model: "compatible-test-model",
    });

    const detail = await desktopApi.getSkill("skill-openai-docs");
    const canonicalEndpoint = normalizeCompatibleEndpoint(configured.compatibleBaseUrl);
    const expectedSourceHash = await sha256Text([
      "skill-description-confirmation-v1",
      "compatible",
      configured.compatibleModel,
      canonicalEndpoint,
      "zh-CN",
      "summarize",
      detail.summary.name,
      "description",
      detail.summary.description,
    ].join("\u0000"));
    await expect(desktopApi.generateSkillDescription({
      locationId: detail.summary.id,
      targetLocale: "zh-CN",
      mode: "summarize",
      force: true,
      allowRemoteManifestExcerpt: false,
      expectedSourceHash,
    })).resolves.toMatchObject({
      status: "ready",
      origin: "openaiCompatible",
      providerId: "compatible",
      modelId: "compatible-test-model",
    });

    const batchSkill = await desktopApi.getSkill("skill-note-curator");
    const batchHash = await sha256Text([
      "skill-description-confirmation-v1",
      "compatible",
      configured.compatibleModel,
      canonicalEndpoint,
      "zh-CN",
      "translate",
      batchSkill.summary.name,
      "description",
      batchSkill.summary.description,
    ].join("\u0000"));
    const started = await desktopApi.startSkillDescriptionJob({
      locationIds: [batchSkill.summary.id],
      targetLocale: "zh-CN",
      mode: "translate",
      force: true,
      expectedSourceHashes: { [batchSkill.summary.id]: batchHash },
    });
    let completed = started;
    for (let attempt = 0; attempt < 4 && completed.status !== "completed"; attempt += 1) {
      completed = (await desktopApi.getSkillDescriptionJob(started.id))!;
    }
    expect(completed).toMatchObject({ status: "completed", succeeded: 1, failed: 0 });

    await desktopApi.updateAiDescriptionSettings({
      compatibleBaseUrl: "https://changed.example.com/v1",
    });
    await expect(desktopApi.generateSkillDescription({
      locationId: batchSkill.summary.id,
      targetLocale: "zh-CN",
      mode: "translate",
      force: true,
      allowRemoteManifestExcerpt: false,
      expectedSourceHash: batchHash,
    })).rejects.toMatchObject({ code: "SOURCE_CHANGED", retryable: true });

    await desktopApi.setAiProviderSecret(syntheticProviderToken("openai-independent"), "openai");
    const compatibleCleared = await desktopApi.deleteAiProviderSecret("compatible");
    expect(compatibleCleared.compatibleApiKeyConfigured).toBe(false);
    expect(compatibleCleared.openaiKeyState).toBe("stored");
    await expect(desktopApi.testAiDescriptionProvider()).rejects.toMatchObject({
      code: "AI_NOT_CONFIGURED",
    });

    await desktopApi.deleteAiProviderSecret("openai");
    await desktopApi.updateAiDescriptionSettings({ provider: "local" });
  });

  it("生成、手工覆盖与清除中文简介均不改写英文原文", async () => {
    await desktopApi.updateAiDescriptionSettings({
      enabled: true,
      provider: "local",
      localEndpoint: "http://127.0.0.1:11434",
      localModel: "qwen3:4b",
      defaultMode: "summarize",
    });
    const before = await desktopApi.getSkill("skill-openai-docs");
    expect(before.summary.description).toMatch(/^Answer questions/u);

    const generated = await desktopApi.generateSkillDescription({
      locationId: "skill-openai-docs",
      targetLocale: "zh-CN",
      mode: "summarize",
      force: true,
      allowRemoteManifestExcerpt: false,
    });
    expect(generated).toMatchObject({
      locale: "zh-CN",
      status: "ready",
      mode: "summarize",
      origin: "localModel",
    });

    const manual = await desktopApi.setManualSkillDescription({
      locationId: "skill-openai-docs",
      targetLocale: "zh-CN",
      text: "手工维护的 OpenAI 官方文档检索与引用说明。",
    });
    expect(manual.mode).toBe("manual");
    let scanned = await desktopApi.scanSkills({ projectIds: [], includePluginCache: true });
    let skill = scanned.find((candidate) => candidate.id === "skill-openai-docs")!;
    expect(skill.descriptionLocalization?.text).toBe(manual.text);
    expect(skill.description).toBe(before.summary.description);

    await desktopApi.clearSkillDescription({
      locationId: skill.id,
      targetLocale: "zh-CN",
      mode: "manual",
    });
    scanned = await desktopApi.scanSkills({ projectIds: [], includePluginCache: true });
    skill = scanned.find((candidate) => candidate.id === "skill-openai-docs")!;
    expect(skill.descriptionLocalization?.mode).toBe("summarize");

    await desktopApi.clearSkillDescription({
      locationId: skill.id,
      targetLocale: "zh-CN",
    });
    scanned = await desktopApi.scanSkills({ projectIds: [], includePluginCache: true });
    skill = scanned.find((candidate) => candidate.id === "skill-openai-docs")!;
    expect(skill.descriptionLocalization).toEqual({ locale: "zh-CN", status: "missing" });
  });

  it("批量任务可轮询完成、报告计数并取消", async () => {
    await desktopApi.updateAiDescriptionSettings({
      enabled: true,
      provider: "local",
      localModel: "qwen3:4b",
    });
    const locationIds = ["skill-openai-docs", "skill-deploy-helper", "skill-note-curator"];
    const started = await desktopApi.startSkillDescriptionJob({
      locationIds,
      targetLocale: "zh-CN",
      mode: "translate",
      force: true,
    });
    expect(started).toMatchObject({ status: "queued", total: 3, completed: 0 });

    let job = started;
    for (let attempt = 0; attempt < 5 && job.status !== "completed"; attempt += 1) {
      job = (await desktopApi.getSkillDescriptionJob(started.id))!;
    }
    expect(job).toMatchObject({
      status: "completed",
      total: 3,
      completed: 3,
      succeeded: 3,
      skipped: 0,
      failed: 0,
    });
    expect(job.failures).toEqual([]);

    const cancellable = await desktopApi.startSkillDescriptionJob({
      locationIds,
      targetLocale: "zh-CN",
      mode: "summarize",
      force: true,
    });
    await expect(desktopApi.cancelSkillDescriptionJob(cancellable.id)).resolves.toMatchObject({
      status: "cancelled",
      completed: 0,
    });
    await expect(desktopApi.getSkillDescriptionJob("missing-job")).resolves.toBeNull();
  });

  it("远程生成前拦截疑似密钥，且错误不包含原文", async () => {
    const locationId = "skill-release-notes";
    const original = await desktopApi.readSkillFile(locationId, "SKILL.md");
    const embeddedSecret = syntheticProviderToken("skill-body");
    const sensitive = `${original}\n\nToken: ${embeddedSecret}`;
    await desktopApi.writeSkillFile({
      locationId,
      relativePath: "SKILL.md",
      content: sensitive,
      expectedHash: await sha256Text(original),
    });
    await desktopApi.setAiProviderSecret(syntheticProviderToken("browser-mock"));
    await desktopApi.updateAiDescriptionSettings({ enabled: true, provider: "openai" });

    try {
      await desktopApi.generateSkillDescription({
        locationId,
        targetLocale: "zh-CN",
        mode: "summarize",
        force: true,
        allowRemoteManifestExcerpt: false,
      });
      throw new Error("expected sensitive input rejection");
    } catch (error) {
      expect(error).toMatchObject({ code: "AI_SENSITIVE_INPUT" });
      expect((error as Error).message).not.toContain(embeddedSecret);
    } finally {
      await desktopApi.writeSkillFile({
        locationId,
        relativePath: "SKILL.md",
        content: original,
        expectedHash: await sha256Text(sensitive),
      });
      await desktopApi.deleteAiProviderSecret();
      await desktopApi.updateAiDescriptionSettings({ provider: "local" });
    }
  });
});
