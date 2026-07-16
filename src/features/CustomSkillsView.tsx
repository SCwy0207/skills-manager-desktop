import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, FileCode2, Globe2, Link2, LoaderCircle, MessageSquareText, Save, ShieldCheck, Sparkles, Wrench } from "lucide-react";

import { ErrorState, StateBadge } from "../components/Common";
import { desktopApi } from "../lib/ipc";
import type { CustomSkillRun, SaveOpenApiSearchProfileRequest, SessionSummary } from "../types";

const defaultOpenApiExample = JSON.stringify({
  openapi: "3.0.3",
  servers: [{ url: "https://search.example.com" }],
  paths: {
    "/skills/search": {
      get: {
        operationId: "searchSkills",
        parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "OK" } },
      },
    },
  },
}, null, 2);

function sessionDisplayTitle(session: SessionSummary) {
  return session.title.trim() && session.title !== "Untitled session" ? session.title : "未命名会话";
}

function sessionDisplayPreview(session: SessionSummary) {
  const preview = session.preview.trim();
  if (!preview || preview.startsWith("<environment_context>")) {
    return "本地会话上下文；选中后将提取可验证的业务证据。";
  }
  return preview;
}

export function CustomSkillsView() {
  const queryClient = useQueryClient();
  const sessionsQuery = useQuery({
    queryKey: ["sessions", "custom-skill-picker"],
    queryFn: () => desktopApi.searchSessions({ query: "", archived: null, limit: 100 }),
  });
  const profilesQuery = useQuery({
    queryKey: ["openapi-search-profiles"],
    queryFn: desktopApi.listOpenApiSearchProfiles,
  });
  const [prompt, setPrompt] = useState("");
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [useWeb, setUseWeb] = useState(false);
  const [profileId, setProfileId] = useState("");
  const [run, setRun] = useState<CustomSkillRun | null>(null);
  const [answer, setAnswer] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [savePath, setSavePath] = useState("");

  const enabledProfiles = useMemo(
    () => (profilesQuery.data ?? []).filter((profile) => profile.enabled),
    [profilesQuery.data],
  );
  const selectedSessions = (sessionsQuery.data ?? []).filter((session) => selectedSessionIds.includes(session.id));

  const startMutation = useMutation({
    mutationFn: () => desktopApi.startCustomSkillRun({
      prompt,
      sessionIds: selectedSessionIds,
      useWeb,
      searchProfileId: useWeb ? profileId || null : null,
    }),
    onSuccess: (result) => {
      setRun(result);
      setAnswer("");
      setSavePath("");
    },
  });
  const answerMutation = useMutation({
    mutationFn: () => desktopApi.answerCustomSkillQuestion({ runId: run!.id, answer }),
    onSuccess: (result) => {
      setRun(result);
      setAnswer("");
    },
  });
  const generateMutation = useMutation({
    mutationFn: () => desktopApi.generateCustomSkill({ runId: run!.id }),
    onSuccess: (result) => setRun(result),
  });
  const validateMutation = useMutation({
    mutationFn: () => desktopApi.validateCustomSkillRun(run!.id),
    onSuccess: (result) => setRun(result),
  });
  const saveMutation = useMutation({
    mutationFn: () => desktopApi.saveCustomSkill({ runId: run!.id, overrideReason: overrideReason || null }),
    onSuccess: async (result) => {
      setSavePath(result.path);
      await queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });

  const toggleSession = (session: SessionSummary) => {
    setSelectedSessionIds((current) => current.includes(session.id)
      ? current.filter((id) => id !== session.id)
      : [...current, session.id]);
  };
  const busy = startMutation.isPending || answerMutation.isPending || generateMutation.isPending || validateMutation.isPending || saveMutation.isPending;
  const error = startMutation.error ?? answerMutation.error ?? generateMutation.error ?? validateMutation.error ?? saveMutation.error;

  return (
    <div className="utility-page custom-skills-page">
      <div className="utility-page-header">
        <div>
          <span className="eyebrow">CUSTOM SKILLS</span>
          <h1>自定义 Skills 工作台</h1>
          <p>用简短需求开始；完成追问后生成可审阅、可验证的本地 Skill。</p>
        </div>
        {run && <StateBadge tone={run.status === "saved" ? "success" : run.status === "interview" ? "warning" : "neutral"}>{run.status}</StateBadge>}
      </div>

      <div className="utility-content">
        {!run && <section className="settings-section">
          <h2>1. 需求与证据</h2>
          <div className="settings-card custom-skills-card">
            <label className="form-field">
              <span>你希望这个 Skill 做什么？</span>
              <textarea value={prompt} onChange={(event) => setPrompt(event.currentTarget.value)} rows={4} placeholder="例如：根据客户会议记录生成合规的项目周报" />
              <small>可以很简短；系统会继续追问触发条件、输入、输出和约束。</small>
            </label>

            <div className="custom-skills-subsection">
              <div><strong>参考 Sessions（可选）</strong><p>选中后，业务事实以这些会话为准，网页结果不能覆盖它们。</p></div>
              {sessionsQuery.isLoading ? <p>正在读取本地会话…</p> : sessionsQuery.isError ? <ErrorState error={sessionsQuery.error} onRetry={() => sessionsQuery.refetch()} /> : (
                <div className="custom-session-list" role="group" aria-label="参考 Sessions">
                  {(sessionsQuery.data ?? []).map((session) => (
                    <label className="check-field custom-session-option" key={session.id}>
                      <input type="checkbox" checked={selectedSessionIds.includes(session.id)} onChange={() => toggleSession(session)} />
                      <span className="checkbox-visual"><Check size={12} /></span>
                      <span className="custom-session-copy"><strong>{sessionDisplayTitle(session)}</strong><small>{sessionDisplayPreview(session)}</small></span>
                    </label>
                  ))}
                </div>
              )}
              {selectedSessions.length > 0 && <p className="custom-evidence-note"><MessageSquareText size={14} /> 已选择 {selectedSessions.length} 个会话；生成和语义校验会列出其证据片段。</p>}
            </div>

            <label className="check-field">
              <input type="checkbox" checked={useWeb} onChange={(event) => setUseWeb(event.currentTarget.checked)} />
              <span className="checkbox-visual"><Check size={12} /></span>
              <span><strong><Globe2 size={14} /> 联网增强</strong><small>仅用需求摘要搜索候选 Skill。外部内容不可信，只可吸收方法和结构。</small></span>
            </label>
            {useWeb && <label className="form-field">
              <span>OpenAPI 搜索配置</span>
              <select value={profileId} onChange={(event) => setProfileId(event.currentTarget.value)}>
                <option value="">选择一个启用的配置</option>
                {enabledProfiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name} · {profile.endpointHost}</option>)}
              </select>
              {!enabledProfiles.length && <small>请先在设置中添加受限 OpenAPI 搜索配置。</small>}
            </label>}
            <button type="button" className="button primary" disabled={!prompt.trim() || busy || (useWeb && !profileId)} onClick={() => startMutation.mutate()}>
              {startMutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />} 开始梳理需求
            </button>
          </div>
        </section>}

        {run && <RunWorkspace
          run={run}
          answer={answer}
          setAnswer={setAnswer}
          overrideReason={overrideReason}
          setOverrideReason={setOverrideReason}
          savePath={savePath}
          busy={busy}
          onAnswer={() => answerMutation.mutate()}
          onGenerate={() => generateMutation.mutate()}
          onValidate={() => validateMutation.mutate()}
          onSave={() => saveMutation.mutate()}
          onRestart={() => { setRun(null); setOverrideReason(""); setSavePath(""); }}
        />}
        {error && <div className="form-error" role="alert"><AlertTriangle size={14} />{error.message}</div>}
      </div>
    </div>
  );
}

function RunWorkspace({ run, answer, setAnswer, overrideReason, setOverrideReason, savePath, busy, onAnswer, onGenerate, onValidate, onSave, onRestart }: {
  run: CustomSkillRun; answer: string; setAnswer: (value: string) => void; overrideReason: string; setOverrideReason: (value: string) => void; savePath: string; busy: boolean;
  onAnswer: () => void; onGenerate: () => void; onValidate: () => void; onSave: () => void; onRestart: () => void;
}) {
  const needsOverride = Boolean(run.validation && run.validation.status !== "passed");
  return <>
    <section className="settings-section">
      <div className="section-heading-row"><div><h2>需求台账</h2><p>生成前必须补齐所有必答项。</p></div><button type="button" className="button secondary small" disabled={busy} onClick={onRestart}>重新开始</button></div>
      <div className="settings-card custom-skills-card">
        {run.requirements.map((item) => <div className="custom-requirement" key={item.id}><strong>{item.label}</strong><p>{item.value}</p></div>)}
        {run.question && <label className="form-field"><span>{run.question.prompt}</span><textarea rows={3} value={answer} onChange={(event) => setAnswer(event.currentTarget.value)} autoFocus /><button type="button" className="button primary" disabled={!answer.trim() || busy} onClick={onAnswer}>提交并继续</button></label>}
        {run.status === "ready" && <button type="button" className="button primary" disabled={busy} onClick={onGenerate}><Sparkles size={15} />生成 Skill</button>}
      </div>
    </section>

    {(run.sessionEvidence.length > 0 || run.webCandidates.length > 0) && <section className="settings-section"><h2>来源与优先级</h2><div className="settings-card custom-skills-card">
      {run.sessionEvidence.length > 0 && <div><strong>Session 证据（最高优先级）</strong>{run.sessionEvidence.map((evidence) => <details key={evidence.sessionId}><summary>{evidence.title} · {evidence.contentHash.slice(0, 18)}…</summary><p>{evidence.excerpt}</p><small>{evidence.sourcePosition}</small></details>)}</div>}
      {run.webCandidates.length > 0 && <div><strong>联网候选（不可信参考）</strong>{run.webCandidates.map((candidate) => <p key={candidate.url}><a href={candidate.url} target="_blank" rel="noreferrer">{candidate.title}</a> · {candidate.source} · {candidate.license ?? "license unknown"}<br /><small>{candidate.summary}</small></p>)}</div>}
    </div></section>}

    {run.files.length > 0 && <section className="settings-section"><div className="section-heading-row"><div><h2>生成文件</h2><p>先预览，再进行三层验证。</p></div><button type="button" className="button secondary small" disabled={busy} onClick={onValidate}><ShieldCheck size={14} />重新验证</button></div><div className="settings-card custom-skills-card">
      {run.files.map((file) => <details key={file.path}><summary><FileCode2 size={14} /> {file.path}</summary><pre className="custom-file-preview">{file.content}</pre></details>)}
    </div></section>}

    {run.validation && <section className="settings-section"><h2>验证报告</h2><div className="settings-card custom-skills-card"><p><StateBadge tone={run.validation.status === "passed" ? "success" : run.validation.status === "blocked" ? "danger" : "warning"}>{run.validation.status}</StateBadge> 规范：{run.validation.structuralStatus} · 安全：{run.validation.securityStatus} · 语义：{run.validation.semanticStatus}</p>
      {run.validation.issues.length === 0 ? <p className="custom-evidence-note"><ShieldCheck size={15} />未发现缺失、冲突或无依据扩展。</p> : run.validation.issues.map((issue, index) => <div className="form-error" key={`${issue.kind}-${index}`}><AlertTriangle size={14} /><span><strong>{issue.kind}</strong>：{issue.message}{issue.sessionIds.length > 0 && `（会话：${issue.sessionIds.join("、")}）`}</span></div>)}
      {needsOverride && run.validation.securityStatus !== "blocked" && <label className="form-field"><span>确认覆盖理由</span><textarea rows={2} value={overrideReason} onChange={(event) => setOverrideReason(event.currentTarget.value)} placeholder="说明为什么接受这些语义或规范风险" /></label>}
      {savePath ? <p className="custom-evidence-note"><Save size={15} />已保存至 {savePath}</p> : <button type="button" className="button primary" disabled={busy || run.validation.status === "blocked" || (needsOverride && !overrideReason.trim())} onClick={onSave}><Save size={15} />保存并接入 Agent</button>}
    </div></section>}
  </>;
}

export function CustomSkillsSettingsSection() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({ queryKey: ["custom-skills-settings"], queryFn: desktopApi.getCustomSkillsSettings });
  const profilesQuery = useQuery({ queryKey: ["openapi-search-profiles"], queryFn: desktopApi.listOpenApiSearchProfiles });
  const [profile, setProfile] = useState<SaveOpenApiSearchProfileRequest>({ name: "", specification: defaultOpenApiExample, operationId: "searchSkills", queryParameter: "q", resultsPointer: "/items", apiKey: "", enabled: true });
  const [repairResult, setRepairResult] = useState("");
  const settingsMutation = useMutation({ mutationFn: desktopApi.updateCustomSkillsSettings, onSuccess: () => queryClient.invalidateQueries({ queryKey: ["custom-skills-settings"] }) });
  const profileMutation = useMutation({ mutationFn: desktopApi.saveOpenApiSearchProfile, onSuccess: () => queryClient.invalidateQueries({ queryKey: ["openapi-search-profiles"] }) });
  const repairMutation = useMutation({ mutationFn: desktopApi.repairCustomSkills, onSuccess: (result) => setRepairResult(`${result.agentType}: ${result.linked} linked, ${result.existing} healthy${result.conflicts.length ? `, ${result.conflicts.length} conflicts` : ""}. ${result.cursorPrompt ?? result.promptStatus}`) });
  const error = settingsMutation.error ?? profileMutation.error ?? repairMutation.error;

  return <section className="settings-section"><h2>Custom Skills</h2><div className="settings-card custom-skills-card">
    {settingsQuery.data && <><p><strong>技能库：</strong><code>{settingsQuery.data.libraryPath}</code></p><label className="check-field"><input type="checkbox" checked={settingsQuery.data.allowRemoteSessionContext} disabled={settingsMutation.isPending} onChange={(event) => settingsMutation.mutate({ allowRemoteSessionContext: event.currentTarget.checked })} /><span className="checkbox-visual"><Check size={12} /></span><span><strong>允许远程 Session 上下文</strong><small>默认关闭。开启后，远程 Provider 会获得脱敏后的必要会话上下文，无需每次确认。</small></span></label></>}
    <div className="custom-skills-subsection"><strong>OpenAPI 搜索配置</strong><p>仅接受 HTTPS 的 GET/POST 搜索操作；禁止重定向、内网地址与外部 $ref。</p><label className="form-field"><span>配置名称</span><input value={profile.name} onChange={(event) => setProfile((value) => ({ ...value, name: event.currentTarget.value }))} placeholder="公开 Skills 搜索" /></label><div className="custom-profile-grid"><label className="form-field"><span>operationId</span><input value={profile.operationId} onChange={(event) => setProfile((value) => ({ ...value, operationId: event.currentTarget.value }))} /></label><label className="form-field"><span>查询参数</span><input value={profile.queryParameter} onChange={(event) => setProfile((value) => ({ ...value, queryParameter: event.currentTarget.value }))} /></label><label className="form-field"><span>结果 JSON Pointer</span><input value={profile.resultsPointer} onChange={(event) => setProfile((value) => ({ ...value, resultsPointer: event.currentTarget.value }))} /></label></div><label className="form-field"><span>OpenAPI 3.x JSON</span><textarea rows={7} value={profile.specification} onChange={(event) => setProfile((value) => ({ ...value, specification: event.currentTarget.value }))} /></label><label className="form-field"><span>API Key（仅存系统凭据库，留空不修改已有密钥）</span><input type="password" value={profile.apiKey ?? ""} onChange={(event) => setProfile((value) => ({ ...value, apiKey: event.currentTarget.value }))} /></label><button type="button" className="button secondary small" disabled={profileMutation.isPending} onClick={() => profileMutation.mutate(profile)}><Globe2 size={14} />保存搜索配置</button>
      {(profilesQuery.data ?? []).map((item) => <p key={item.id}><Globe2 size={13} /> {item.name} · {item.endpointHost} · {item.operationId} · {item.apiKeyConfigured ? "key stored" : "no key"}</p>)}</div>
    <div className="custom-skills-subsection"><strong>Custom Skills Repair</strong><p>重建用户级原生 Skills 链接；Codex/Claude 同时修复带唯一标记的全局引导块。Cursor 会给出需粘贴到 Settings &gt; Rules 的引导文本。</p><div className="custom-repair-actions">{(["codex", "claude", "cursor"] as const).map((agent) => <button type="button" className="button secondary small" key={agent} disabled={repairMutation.isPending} onClick={() => repairMutation.mutate({ agentType: agent })}><Wrench size={14} />修复 {agent}</button>)}</div>{repairResult && <p className="custom-evidence-note"><Link2 size={14} />{repairResult}</p>}</div>
    {error && <div className="form-error"><AlertTriangle size={14} />{error.message}</div>}
  </div></section>;
}
