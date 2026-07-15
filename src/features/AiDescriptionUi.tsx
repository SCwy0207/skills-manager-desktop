import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BrainCircuit,
  Check,
  CheckCircle2,
  Cloud,
  Globe2,
  Info,
  KeyRound,
  Languages,
  LoaderCircle,
  PenLine,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  Trash2,
  WandSparkles,
  X,
} from "lucide-react";

import { StateBadge, formatRelativeTime } from "../components/Common";
import { useI18n } from "../i18n/i18n";
import { DesktopApiError, desktopApi, normalizeCompatibleEndpoint } from "../lib/ipc";
import { sha256Text } from "../lib/hash";
import { useUiStore } from "../store/ui";
import type {
  AiDescriptionMode,
  AiDescriptionSettings,
  DescriptionJob,
  LocalAiProvider,
  Project,
  SkillDescriptionLocalization,
  SkillDescriptionJobFailure,
  SkillSummary,
} from "../types";

const TARGET_LOCALE = "zh-CN" as const;

export function remoteConfirmationPayload(
  settings: AiDescriptionSettings,
  mode: AiDescriptionMode,
  name: string,
  sourceScope: "description" | "manifestExcerpt",
  source: string,
) {
  const fields = [
    "skill-description-confirmation-v1",
    settings.provider,
    settings.provider === "compatible" ? settings.compatibleModel : settings.openaiModel,
  ];
  if (settings.provider === "compatible") {
    fields.push(normalizeCompatibleEndpoint(settings.compatibleBaseUrl));
  }
  fields.push(
    TARGET_LOCALE,
    mode,
    name,
    sourceScope,
    source,
  );
  return fields.join("\u0000");
}

function isRemoteProvider(
  settings?: AiDescriptionSettings,
): settings is AiDescriptionSettings & { provider: "openai" | "compatible" } {
  return Boolean(settings && settings.provider !== "local");
}

export function remoteProviderDomain(settings?: AiDescriptionSettings) {
  if (!settings || settings.provider === "local") return "";
  if (settings.provider === "openai") return "api.openai.com";
  try {
    return new URL(normalizeCompatibleEndpoint(settings.compatibleBaseUrl)).host;
  } catch {
    return settings.compatibleBaseUrl.trim() || "—";
  }
}

function terminalJob(job?: DescriptionJob | null) {
  return Boolean(job && ["completed", "cancelled", "failed"].includes(job.status));
}

function apiErrorCode(error: unknown) {
  return error instanceof DesktopApiError ? error.code : undefined;
}

function providerReady(settings?: AiDescriptionSettings, hasPendingSecret = false) {
  if (!settings?.enabled) return false;
  if (settings.provider === "local") return Boolean(settings.localModel?.trim());
  if (settings.provider === "openai") {
    return hasPendingSecret || settings.openaiKeyState !== "missing";
  }
  if (
    !settings.compatibleModel.trim() ||
    (!hasPendingSecret && !settings.compatibleApiKeyConfigured)
  ) return false;
  try {
    normalizeCompatibleEndpoint(settings.compatibleBaseUrl);
    return true;
  } catch {
    return false;
  }
}

function settingsPatch(settings: AiDescriptionSettings) {
  return {
    enabled: settings.enabled,
    provider: settings.provider,
    localEndpoint: settings.localEndpoint,
    localModel: settings.localModel,
    openaiModel: settings.openaiModel,
    compatibleBaseUrl: settings.compatibleBaseUrl,
    compatibleModel: settings.compatibleModel,
    defaultMode: settings.defaultMode,
  };
}

export function mergeCredentialStatus(
  current: AiDescriptionSettings,
  credentialResult: AiDescriptionSettings,
) {
  return {
    ...current,
    openaiKeyState: credentialResult.openaiKeyState,
    compatibleApiKeyConfigured: credentialResult.compatibleApiKeyConfigured,
  };
}

type AiSettingsSubmissionStage = "settings" | "credential" | "test" | "busy";

export class AiSettingsSubmissionError extends Error {
  readonly stage: AiSettingsSubmissionStage;
  readonly reason: string;
  readonly savedSettings?: AiDescriptionSettings;

  constructor(
    stage: AiSettingsSubmissionStage,
    reason: string,
    savedSettings?: AiDescriptionSettings,
  ) {
    super(reason);
    this.name = "AiSettingsSubmissionError";
    this.stage = stage;
    this.reason = reason;
    this.savedSettings = savedSettings;
  }
}

interface AiSettingsSubmissionApi {
  updateAiDescriptionSettings: typeof desktopApi.updateAiDescriptionSettings;
  setAiProviderSecret: typeof desktopApi.setAiProviderSecret;
}

function submissionReason(error: unknown, secret: string) {
  const fallback = "Desktop API request failed";
  const message = error instanceof Error ? error.message : fallback;
  return secret ? message.split(secret).join("[redacted]") : message;
}

export async function saveAiSettingsAndOptionalSecret(
  settings: AiDescriptionSettings,
  pendingSecret: string,
  api: AiSettingsSubmissionApi = desktopApi,
) {
  const secret = pendingSecret.trim();
  let savedSettings: AiDescriptionSettings;
  try {
    savedSettings = await api.updateAiDescriptionSettings(settingsPatch(settings));
  } catch (error) {
    throw new AiSettingsSubmissionError(
      "settings",
      submissionReason(error, secret),
    );
  }

  if (!secret || settings.provider === "local") {
    return { settings: savedSettings, credentialSaved: false };
  }

  try {
    const credentialSettings = await api.setAiProviderSecret(secret, settings.provider);
    return { settings: credentialSettings, credentialSaved: true };
  } catch (error) {
    throw new AiSettingsSubmissionError(
      "credential",
      submissionReason(error, secret),
      savedSettings,
    );
  }
}

function invalidateSkillDescriptions(queryClient: ReturnType<typeof useQueryClient>, locationId?: string) {
  const promises = [
    queryClient.invalidateQueries({ queryKey: ["skills"] }),
    queryClient.invalidateQueries({ queryKey: ["audit-logs"] }),
  ];
  if (locationId) promises.push(queryClient.invalidateQueries({ queryKey: ["skill", locationId] }));
  return Promise.all(promises);
}

export function AiDescriptionSettingsSection() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ["ai-description-settings"],
    queryFn: desktopApi.getAiDescriptionSettings,
  });
  const [draft, setDraft] = useState<AiDescriptionSettings | null>(null);
  const settingsSnapshotRef = useRef<AiDescriptionSettings | null>(null);
  const secretInputRef = useRef<HTMLInputElement>(null);
  const submissionLockRef = useRef(false);
  const [secretPresent, setSecretPresent] = useState(false);
  const [detected, setDetected] = useState<LocalAiProvider[]>([]);

  useEffect(() => {
    if (!settingsQuery.data) return;
    const previous = settingsSnapshotRef.current;
    settingsSnapshotRef.current = settingsQuery.data;
    setDraft((current) => {
      if (
        current &&
        previous &&
        JSON.stringify(settingsPatch(previous)) === JSON.stringify(settingsPatch(settingsQuery.data))
      ) {
        return mergeCredentialStatus(current, settingsQuery.data);
      }
      return settingsQuery.data;
    });
  }, [settingsQuery.data]);

  const publishSavedSettings = (settings: AiDescriptionSettings) => {
    settingsSnapshotRef.current = settings;
    setDraft(settings);
    queryClient.setQueryData(["ai-description-settings"], settings);
  };

  const clearSecretDraft = () => {
    if (secretInputRef.current) secretInputRef.current.value = "";
    setSecretPresent(false);
  };

  const submitSettings = async (settings: AiDescriptionSettings, testConnection: boolean) => {
    if (submissionLockRef.current) {
      throw new AiSettingsSubmissionError("busy", "Another settings request is already running");
    }
    submissionLockRef.current = true;
    const pendingSecret = secretInputRef.current?.value.trim() ?? "";
    try {
      let saved: Awaited<ReturnType<typeof saveAiSettingsAndOptionalSecret>>;
      try {
        saved = await saveAiSettingsAndOptionalSecret(settings, pendingSecret);
      } catch (error) {
        if (error instanceof AiSettingsSubmissionError && error.savedSettings) {
          publishSavedSettings(error.savedSettings);
        }
        throw error;
      }

      publishSavedSettings(saved.settings);
      if (saved.credentialSaved) clearSecretDraft();
      if (!testConnection) return null;

      try {
        return await desktopApi.testAiDescriptionProvider();
      } catch (error) {
        throw new AiSettingsSubmissionError(
          "test",
          submissionReason(error, pendingSecret),
          saved.settings,
        );
      }
    } finally {
      submissionLockRef.current = false;
    }
  };

  const saveMutation = useMutation({
    mutationFn: (settings: AiDescriptionSettings) => submitSettings(settings, false),
  });

  const detectMutation = useMutation({
    mutationFn: async (settings: AiDescriptionSettings) => {
      const saved = await desktopApi.updateAiDescriptionSettings(settingsPatch(settings));
      queryClient.setQueryData(["ai-description-settings"], saved);
      return desktopApi.detectLocalAiProviders();
    },
    onSuccess: (providers) => {
      setDetected(providers);
      const firstAvailable = providers.find((provider) => provider.available);
      if (firstAvailable) {
        setDraft((current) => current ? {
          ...current,
          localEndpoint: firstAvailable.endpoint,
          localModel: firstAvailable.models[0] ?? current.localModel,
        } : current);
      }
    },
  });

  const testMutation = useMutation({
    mutationFn: (settings: AiDescriptionSettings) => submitSettings(settings, true),
  });

  const deleteSecretMutation = useMutation({
    mutationFn: (provider: "openai" | "compatible") =>
      desktopApi.deleteAiProviderSecret(provider),
    onSuccess: (settings) => {
      setDraft((current) => current ? mergeCredentialStatus(current, settings) : settings);
      queryClient.setQueryData<AiDescriptionSettings>(
        ["ai-description-settings"],
        (current) => current ? mergeCredentialStatus(current, settings) : settings,
      );
    },
  });

  if (settingsQuery.isLoading || !draft) {
    return (
      <section className="settings-section ai-settings-section" id="ai-description-settings">
        <h2>{t("skills.ai.title")}</h2>
        <div className="ai-settings-card loading" aria-label={t("skills.ai.loadingSettings")}>
          <span className="skeleton skeleton-detail-line" />
          <span className="skeleton skeleton-detail-body" />
        </div>
      </section>
    );
  }

  const providerModels = detected.find((provider) => provider.endpoint === draft.localEndpoint)?.models ?? [];
  const secretAvailable = draft.provider === "compatible"
    ? draft.compatibleApiKeyConfigured
    : draft.openaiKeyState !== "missing";
  const secretFromEnvironment = draft.provider === "openai" && draft.openaiKeyState === "environment";
  const dirty = JSON.stringify(settingsPatch(draft)) !== JSON.stringify(settingsPatch(settingsQuery.data ?? draft));
  const hasPendingChanges = dirty || secretPresent;
  const readyForSubmission = providerReady({
    ...draft,
    openaiKeyState: draft.provider === "openai" && secretPresent ? "stored" : draft.openaiKeyState,
    compatibleApiKeyConfigured:
      draft.provider === "compatible" && secretPresent
        ? true
        : draft.compatibleApiKeyConfigured,
  });
  const busy =
    saveMutation.isPending ||
    testMutation.isPending ||
    detectMutation.isPending ||
    deleteSecretMutation.isPending;
  const submissionError = saveMutation.error ?? testMutation.error;
  const describeSubmissionError = (error: unknown) => {
    if (error instanceof AiSettingsSubmissionError) {
      return t(`skills.ai.submitError.${error.stage}`, { message: error.reason });
    }
    return error instanceof Error ? error.message : t("skills.ai.submitError.unknown");
  };
  const resetSubmissionFeedback = () => {
    saveMutation.reset();
    testMutation.reset();
  };
  const editDraft = (patch: Partial<AiDescriptionSettings>) => {
    resetSubmissionFeedback();
    setDraft({ ...draft, ...patch });
  };
  const selectProvider = (provider: AiDescriptionSettings["provider"]) => {
    if (secretPresent && !window.confirm(t("skills.ai.discardCredentialDraftConfirm"))) return;
    clearSecretDraft();
    editDraft({ provider });
  };
  const deleteCredential = (provider: "openai" | "compatible") => {
    if (!window.confirm(t("skills.ai.deleteCredentialConfirm"))) return;
    resetSubmissionFeedback();
    clearSecretDraft();
    deleteSecretMutation.mutate(provider);
  };

  return (
    <section className="settings-section ai-settings-section" id="ai-description-settings">
      <div className="settings-section-title-row">
        <div>
          <h2>{t("skills.ai.title")}</h2>
          <p>{t("skills.ai.settingsDescription")}</p>
        </div>
        <label className="ai-master-toggle">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => editDraft({ enabled: event.currentTarget.checked })}
            disabled={busy}
          />
          <span aria-hidden="true"><i /></span>
          <strong>{draft.enabled ? t("skills.status.enabled") : t("skills.status.off")}</strong>
        </label>
      </div>

      <div className={`ai-settings-card ${draft.enabled ? "enabled" : "disabled"}`}>
        <div className="ai-settings-intro">
          <span className="ai-feature-icon"><BrainCircuit size={20} /></span>
          <div>
            <strong>{t("skills.ai.localFirst")}</strong>
            <p>{t("skills.ai.localFirstDescription")}</p>
          </div>
          <StateBadge tone={draft.provider === "local" ? "success" : "accent"}>
            {draft.provider === "local" ? <Server size={11} /> : <Cloud size={11} />}
            {draft.provider === "local" ? "LOCAL" : "REMOTE · MANUAL"}
          </StateBadge>
        </div>

        <fieldset className="ai-settings-group" disabled={!draft.enabled || busy}>
          <legend>{t("skills.ai.provider")}</legend>
          <div className="provider-segmented" role="radiogroup" aria-label={t("skills.ai.providerAria")}>
            <label className={draft.provider === "local" ? "active" : ""}>
              <input
                type="radio"
                name="ai-provider"
                value="local"
                checked={draft.provider === "local"}
                onChange={() => selectProvider("local")}
              />
              <Server size={15} /><span><strong>{t("skills.ai.localModel")}</strong><small>Ollama / LM Studio</small></span>
            </label>
            <label className={draft.provider === "openai" ? "active" : ""}>
              <input
                type="radio"
                name="ai-provider"
                value="openai"
                checked={draft.provider === "openai"}
                onChange={() => selectProvider("openai")}
              />
              <Cloud size={15} /><span><strong>OpenAI</strong><small>{t("skills.ai.byokManual")}</small></span>
            </label>
            <label className={draft.provider === "compatible" ? "active" : ""}>
              <input
                type="radio"
                name="ai-provider"
                value="compatible"
                checked={draft.provider === "compatible"}
                onChange={() => selectProvider("compatible")}
              />
              <Globe2 size={15} /><span><strong>{t("skills.ai.compatible.title")}</strong><small>{t("skills.ai.compatible.subtitle")}</small></span>
            </label>
          </div>
        </fieldset>

        {draft.provider === "local" ? (
          <div className="ai-provider-panel">
            <div className="ai-provider-panel-heading">
              <div><strong>{t("skills.ai.loopbackService")}</strong><p>{t("skills.ai.loopbackDescription")}</p></div>
              <button type="button" className="button secondary small" onClick={() => { resetSubmissionFeedback(); detectMutation.mutate(draft); }} disabled={!draft.enabled || busy}>
                <RefreshCw size={13} className={detectMutation.isPending ? "spin" : ""} />
                {detectMutation.isPending ? t("skills.ai.detecting") : t("skills.ai.detectService")}
              </button>
            </div>
            <div className="ai-field-grid">
              <label className="form-field">
                <span>{t("skills.ai.localService")}</span>
                <input value={draft.localEndpoint} list="local-ai-endpoints" onChange={(event) => editDraft({ localEndpoint: event.currentTarget.value, localModel: null })} disabled={!draft.enabled || busy} spellCheck={false} />
                <datalist id="local-ai-endpoints">
                  <option value="http://127.0.0.1:11434">Ollama</option>
                  <option value="http://127.0.0.1:1234">LM Studio</option>
                </datalist>
              </label>
              <label className="form-field">
                <span>{t("skills.ai.model")}</span>
                <input
                  value={draft.localModel ?? ""}
                  list="detected-ai-models"
                  onChange={(event) => editDraft({ localModel: event.currentTarget.value || null })}
                  placeholder={t("skills.ai.modelPlaceholder")}
                  disabled={!draft.enabled || busy}
                  spellCheck={false}
                />
                <datalist id="detected-ai-models">{providerModels.map((model) => <option key={model} value={model} />)}</datalist>
              </label>
            </div>
            {detectMutation.isSuccess && (
              <div className="detected-providers" role="status">
                {detected.map((provider) => (
                  <button
                    type="button"
                    key={provider.id}
                    className={provider.available ? "available" : "unavailable"}
                    disabled={!provider.available}
                    onClick={() => editDraft({ localEndpoint: provider.endpoint, localModel: provider.models[0] ?? null })}
                  >
                    <span>{provider.available ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}{provider.name}</span>
                    <small>{provider.available ? t("skills.ai.modelsFound", { count: provider.models.length }) : provider.error ?? t("skills.ai.notRunning")}</small>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : draft.provider === "openai" ? (
          <div className="ai-provider-panel remote" key="openai">
            <div className="remote-disclosure">
              <ShieldCheck size={17} />
              <div>
                <strong>{t("skills.ai.remoteMinimalDisclosure")}</strong>
                <p>{t("skills.ai.remoteMinimalDisclosureDescription")}</p>
              </div>
            </div>
            <div className="ai-field-grid">
              <label className="form-field">
                <span>{t("skills.ai.openaiModel")}</span>
                <input value={draft.openaiModel} onChange={(event) => editDraft({ openaiModel: event.currentTarget.value })} disabled={!draft.enabled || busy} spellCheck={false} />
              </label>
              <div className="form-field api-key-field">
                <span>API Key</span>
                <div className="secret-input-row">
                  <KeyRound size={14} />
                  <input
                    ref={secretInputRef}
                    type="password"
                    onInput={(event) => {
                      resetSubmissionFeedback();
                      setSecretPresent(Boolean(event.currentTarget.value.trim()));
                    }}
                    placeholder={secretAvailable ? t("skills.ai.keyConfiguredPlaceholder") : "sk-…"}
                    disabled={!draft.enabled || secretFromEnvironment || busy}
                    autoComplete="new-password"
                  />
                </div>
                <small>
                  {secretPresent
                    ? t("skills.ai.keyWillSave")
                    : draft.openaiKeyState === "stored"
                      ? t("skills.ai.keyStored")
                      : draft.openaiKeyState === "environment"
                        ? t("skills.ai.keyEnvironment")
                        : t("skills.ai.keyNotPersisted")}
                  {draft.openaiKeyState === "stored" && (
                    <button type="button" className="inline-danger" onClick={() => deleteCredential("openai")} disabled={busy}>{t("skills.ai.deleteCredential")}</button>
                  )}
                </small>
              </div>
            </div>
            <p className="data-retention-note"><Info size={13} />{t("skills.ai.dataRetention")}</p>
          </div>
        ) : (
          <div className="ai-provider-panel remote compatible" key="compatible">
            <div className="remote-disclosure">
              <ShieldCheck size={17} />
              <div>
                <strong>{t("skills.ai.compatible.disclosureTitle")}</strong>
                <p>{t("skills.ai.compatible.disclosureDescription")}</p>
              </div>
            </div>
            <div className="ai-field-grid compatible-field-grid">
              <label className="form-field compatible-base-url-field">
                <span>{t("skills.ai.compatible.baseUrl")}</span>
                <input
                  value={draft.compatibleBaseUrl}
                  onChange={(event) => editDraft({ compatibleBaseUrl: event.currentTarget.value })}
                  placeholder="https://api.example.com"
                  disabled={!draft.enabled || busy}
                  inputMode="url"
                  spellCheck={false}
                />
                <small>{t("skills.ai.compatible.endpointHelp")}</small>
              </label>
              <label className="form-field">
                <span>{t("skills.ai.model")}</span>
                <input
                  value={draft.compatibleModel}
                  onChange={(event) => editDraft({ compatibleModel: event.currentTarget.value })}
                  placeholder={t("skills.ai.compatible.modelPlaceholder")}
                  disabled={!draft.enabled || busy}
                  spellCheck={false}
                />
              </label>
              <div className="form-field api-key-field compatible-api-key-field">
                <span>API Key</span>
                <div className="secret-input-row">
                  <KeyRound size={14} />
                  <input
                    ref={secretInputRef}
                    type="password"
                    onInput={(event) => {
                      resetSubmissionFeedback();
                      setSecretPresent(Boolean(event.currentTarget.value.trim()));
                    }}
                    placeholder={secretAvailable ? t("skills.ai.keyConfiguredPlaceholder") : t("skills.ai.compatible.keyPlaceholder")}
                    disabled={!draft.enabled || busy}
                    autoComplete="new-password"
                  />
                </div>
                <small>
                  {secretPresent
                    ? t("skills.ai.keyWillSave")
                    : secretAvailable
                      ? t("skills.ai.compatible.keyStored")
                      : t("skills.ai.keyNotPersisted")}
                  {secretAvailable && (
                    <button type="button" className="inline-danger" onClick={() => deleteCredential("compatible")} disabled={busy}>{t("skills.ai.deleteCredential")}</button>
                  )}
                </small>
              </div>
            </div>
            <p className="data-retention-note"><Info size={13} />{t("skills.ai.compatible.retention")}</p>
          </div>
        )}

        <div className="ai-settings-footer">
          <label>
            <span>{t("skills.ai.defaultMode")}</span>
            <select value={draft.defaultMode} onChange={(event) => editDraft({ defaultMode: event.currentTarget.value as AiDescriptionMode })} disabled={!draft.enabled || busy}>
              <option value="summarize">{t("skills.ai.modeSummariseLong")}</option>
              <option value="translate">{t("skills.ai.modeTranslateLong")}</option>
            </select>
          </label>
          <div className="ai-settings-actions">
            {testMutation.data && (
              <span className={testMutation.data.ok ? "test-result success" : "test-result error"} role="status">
                {testMutation.data.ok ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
                {testMutation.data.message}{testMutation.data.latencyMs ? ` · ${testMutation.data.latencyMs}ms` : ""}
              </span>
            )}
            {saveMutation.isSuccess && !hasPendingChanges && !testMutation.data && (
              <span className="test-result success" role="status"><CheckCircle2 size={13} />{t("skills.ai.settingsSaved")}</span>
            )}
            {submissionError && (
              <span className="test-result error" role="alert"><AlertTriangle size={13} />{describeSubmissionError(submissionError)}</span>
            )}
            {deleteSecretMutation.isError && (
              <span className="test-result error" role="alert"><AlertTriangle size={13} />{deleteSecretMutation.error.message}</span>
            )}
            <button type="button" className="button secondary small" onClick={() => testMutation.mutate(draft)} disabled={!draft.enabled || !readyForSubmission || busy}>
              {testMutation.isPending ? <LoaderCircle className="spin" size={13} /> : <Sparkles size={13} />}
              {testMutation.isPending
                ? t("skills.ai.savingAndTesting")
                : hasPendingChanges
                  ? t("skills.ai.saveAndTest")
                  : t("skills.ai.testConnection")}
            </button>
            <button type="button" className="button primary small" onClick={() => saveMutation.mutate(draft)} disabled={!hasPendingChanges || busy}>
              <Check size={13} />{saveMutation.isPending ? t("skills.common.saving") : t("skills.ai.saveSettings")}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

export function SkillDescriptionPanel({
  skill,
  hasUnsavedChanges,
}: {
  skill: SkillSummary;
  hasUnsavedChanges: boolean;
}) {
  const { locale, t } = useI18n();
  const queryClient = useQueryClient();
  const setSection = useUiStore((state) => state.setSection);
  const settingsQuery = useQuery({
    queryKey: ["ai-description-settings"],
    queryFn: desktopApi.getAiDescriptionSettings,
  });
  const localization = skill.descriptionLocalization;
  const [view, setView] = useState<"localized" | "original">(localization?.text ? "localized" : "original");
  const [mode, setMode] = useState<AiDescriptionMode>(settingsQuery.data?.defaultMode ?? "summarize");
  const [manualEditing, setManualEditing] = useState(false);
  const [manualText, setManualText] = useState(localization?.text ?? "");

  useEffect(() => {
    if (settingsQuery.data) setMode(settingsQuery.data.defaultMode);
  }, [settingsQuery.data]);

  useEffect(() => {
    setManualText(localization?.text ?? "");
    setView(localization?.text ? "localized" : "original");
    setManualEditing(false);
  }, [localization?.text, skill.id]);

  const generatedMutation = useMutation({
    mutationFn: async ({
      allowRemoteManifestExcerpt = false,
      expectedSourceHash,
    }: {
      allowRemoteManifestExcerpt?: boolean;
      expectedSourceHash?: string;
    }) => {
      const forceGeneration = Boolean(localization?.text) || localization?.status === "notNeeded";
      try {
        return await desktopApi.generateSkillDescription({
          locationId: skill.id,
          targetLocale: TARGET_LOCALE,
          mode,
          force: forceGeneration,
          allowRemoteManifestExcerpt,
          expectedSourceHash,
        });
      } catch (error) {
        if (apiErrorCode(error) !== "AI_BODY_CONFIRM_REQUIRED" || allowRemoteManifestExcerpt) throw error;
        const manifest = await desktopApi.readSkillFile(skill.id, "SKILL.md");
        const estimatedCharacters = Math.min(manifest.length, 12 * 1024);
        const settings = settingsQuery.data;
        if (!isRemoteProvider(settings)) throw new DesktopApiError(t("skills.ai.providerChanged"), "SOURCE_CHANGED", true);
        const confirmed = window.confirm(t("skills.ai.confirmBody", {
          domain: remoteProviderDomain(settings),
          characters: estimatedCharacters.toLocaleString(locale),
          tokens: Math.ceil(estimatedCharacters / 3).toLocaleString(locale),
        }));
        if (!confirmed) throw error;
        return desktopApi.generateSkillDescription({
          locationId: skill.id,
          targetLocale: TARGET_LOCALE,
          mode,
          force: forceGeneration,
          allowRemoteManifestExcerpt: true,
          expectedSourceHash: await sha256Text(
            remoteConfirmationPayload(settings, mode, skill.name, "manifestExcerpt", manifest),
          ),
        });
      }
    },
    onSuccess: async (result) => {
      setView(result.text ? "localized" : "original");
      await invalidateSkillDescriptions(queryClient, skill.id);
    },
  });

  const manualMutation = useMutation({
    mutationFn: (text: string) => desktopApi.setManualSkillDescription({ locationId: skill.id, targetLocale: TARGET_LOCALE, text }),
    onSuccess: async () => {
      setManualEditing(false);
      setView("localized");
      await invalidateSkillDescriptions(queryClient, skill.id);
    },
  });

  const clearMutation = useMutation({
    mutationFn: () => desktopApi.clearSkillDescription({ locationId: skill.id, targetLocale: TARGET_LOCALE, mode: localization?.mode }),
    onSuccess: async () => {
      setView("original");
      setManualEditing(false);
      await invalidateSkillDescriptions(queryClient, skill.id);
    },
  });

  const requestGeneration = async () => {
    let expectedSourceHash: string | undefined;
    const currentSettings = settingsQuery.data;
    if (isRemoteProvider(currentSettings)) {
      const fields = skill.description.trim()
        ? t("skills.ai.fieldsNameDescription")
        : t("skills.ai.fieldsNameOnly");
      const estimatedCharacters = skill.name.length + skill.description.length;
      const confirmed = window.confirm(
        t("skills.ai.confirmRemote", {
          domain: remoteProviderDomain(currentSettings),
          fields,
          characters: estimatedCharacters.toLocaleString(locale),
          tokens: Math.ceil(estimatedCharacters / 3).toLocaleString(locale),
        }),
      );
      if (!confirmed) return;
      expectedSourceHash = await sha256Text(
        remoteConfirmationPayload(
          currentSettings,
          mode,
          skill.name,
          "description",
          skill.description,
        ),
      );
    }
    generatedMutation.mutate({ expectedSourceHash });
  };

  useEffect(() => {
    const trigger = () => {
      if (!hasUnsavedChanges && providerReady(settingsQuery.data) && !generatedMutation.isPending) {
        void requestGeneration();
      }
    };
    window.addEventListener("ccc:skill-description:generate", trigger);
    return () => window.removeEventListener("ccc:skill-description:generate", trigger);
  }, [generatedMutation, hasUnsavedChanges, settingsQuery.data]);

  const settings = settingsQuery.data;
  const canGenerate = !hasUnsavedChanges && providerReady(settings) && !generatedMutation.isPending;
  const activeText = view === "localized" && localization?.text ? localization.text : skill.description;
  const mutationError = generatedMutation.error ?? manualMutation.error ?? clearMutation.error;

  return (
    <section className={`skill-localization-panel ${localization?.status === "stale" ? "stale" : ""}`} aria-labelledby="skill-description-title">
      <div className="skill-localization-heading">
        <div>
          <span className="localization-icon"><Languages size={16} /></span>
          <div>
            <strong id="skill-description-title">{t("skills.description.chinese")}</strong>
            <small>{localization?.text ? t("skills.description.localOverlay") : localization?.status === "notNeeded" ? t("skills.description.authorChineseDescription") : t("skills.description.notGenerated")}</small>
          </div>
        </div>
        <div className="description-view-switch" role="group" aria-label={t("skills.description.languageAria")}>
          <button type="button" aria-pressed={view === "localized"} onClick={() => setView("localized")} disabled={!localization?.text}>{t("skills.description.chineseShort")}</button>
          <button type="button" aria-pressed={view === "original"} onClick={() => setView("original")}>{t("skills.description.original")}</button>
        </div>
      </div>

      {manualEditing ? (
        <div className="manual-description-editor">
          <textarea value={manualText} onChange={(event) => setManualText(event.currentTarget.value.slice(0, 100))} maxLength={100} autoFocus aria-label={t("skills.description.manualAria")} />
          <div><span>{manualText.length}/100</span><button type="button" onClick={() => setManualEditing(false)}>{t("skills.common.cancel")}</button><button type="button" className="save" onClick={() => manualMutation.mutate(manualText.trim())} disabled={!manualText.trim() || manualMutation.isPending}>{manualMutation.isPending ? t("skills.common.saving") : t("skills.description.save")}</button></div>
        </div>
      ) : (
        <p className={`localized-description-copy ${view}`}>{activeText || t("skills.description.authorMissing")}</p>
      )}

      <div className="skill-localization-footer">
        <div className="localization-meta">
          {localization?.status === "stale" && <StateBadge tone="warning"><RotateCcw size={11} />{t("skills.description.sourceUpdated")}</StateBadge>}
          {localization?.status === "notNeeded" && <StateBadge tone="success"><CheckCircle2 size={11} />{t("skills.description.authorChinese")}</StateBadge>}
          {localization?.mode && <span>{t(`skills.ai.mode.${localization.mode}`)}</span>}
          {localization?.origin && <span>{t(`skills.ai.origin.${localization.origin}`)}</span>}
          {localization?.modelId && <code>{localization.modelId}</code>}
          {localization?.generatedAt && <span>{formatRelativeTime(localization.generatedAt)}</span>}
        </div>
        <div className="localization-actions">
          <select value={mode} onChange={(event) => setMode(event.currentTarget.value as AiDescriptionMode)} aria-label={t("skills.ai.modeAria")} disabled={generatedMutation.isPending}>
            <option value="summarize">{t("skills.ai.mode.summarize")}</option>
            <option value="translate">{t("skills.ai.mode.translate")}</option>
          </select>
          <button type="button" className="description-action" onClick={() => { setManualText(localization?.text ?? ""); setManualEditing(true); }} disabled={hasUnsavedChanges || manualMutation.isPending} title={t("skills.description.manualTitle")}><PenLine size={13} />{t("skills.description.manual")}</button>
          {localization?.text && <button type="button" className="description-action danger" onClick={() => { if (window.confirm(t("skills.description.clearConfirm"))) clearMutation.mutate(); }} disabled={clearMutation.isPending}><Trash2 size={13} />{t("skills.common.clear")}</button>}
          {settings?.enabled ? (
            <button type="button" className="button primary small" data-skill-ai-generate onClick={() => void requestGeneration()} disabled={!canGenerate} title={hasUnsavedChanges ? t("skills.editor.saveOrDiscard") : isRemoteProvider(settings) ? t("skills.ai.sendAfterConfirm", { domain: remoteProviderDomain(settings) }) : undefined}>
              {generatedMutation.isPending ? <LoaderCircle className="spin" size={13} /> : <WandSparkles size={13} />}
              {generatedMutation.isPending ? t("skills.ai.generating") : localization?.text ? t("skills.ai.regenerate") : localization?.status === "notNeeded" ? t("skills.ai.generateAnyway") : t("skills.ai.generateChinese")}
            </button>
          ) : (
            <button
              type="button"
              className="button secondary small"
              onClick={() => setSection("settings")}
              disabled={hasUnsavedChanges}
              title={hasUnsavedChanges ? t("skills.editor.saveOrDiscard") : undefined}
            ><BrainCircuit size={13} />{t("skills.ai.configure")}</button>
          )}
        </div>
      </div>
      {hasUnsavedChanges && <p className="localization-inline-note"><AlertTriangle size={12} />{t("skills.ai.saveBeforeGenerate")}</p>}
      {mutationError && <p className="localization-inline-note error" role="alert"><AlertTriangle size={12} />{mutationError.message}</p>}
    </section>
  );
}

export function eligibleBatchSkills(skills: SkillSummary[], force: boolean) {
  return skills.filter((skill) => {
    if (
      skill.descriptionLocalization?.mode === "manual"
      || skill.descriptionLocalizations?.some((localization) => localization.mode === "manual")
    ) return false;
    if (isEffectivelyChinese(skill.description) && !force) return false;
    if (!force && skill.descriptionLocalization?.status === "ready") return false;
    return true;
  });
}

export type BatchSkillCategory = "retry" | "needs" | "translated" | "protected";
export type BatchSkillReason = "failed" | "missing" | "stale" | "ready" | "manual" | "notNeeded" | "noSource" | "remoteBodyBlocked";

export interface BatchSkillReviewItem {
  skill: SkillSummary;
  category: BatchSkillCategory;
  reason: BatchSkillReason;
  selectable: boolean;
  selectedByDefault: boolean;
  requiresForce: boolean;
  localization?: SkillDescriptionLocalization;
  failure?: SkillDescriptionJobFailure;
}

function localizationsForSkill(skill: SkillSummary) {
  const localizations = [...(skill.descriptionLocalizations ?? [])];
  const selected = skill.descriptionLocalization;
  if (
    selected?.mode
    && !localizations.some((candidate) => candidate.mode === selected.mode)
  ) {
    localizations.push(selected);
  }
  return localizations;
}

export function buildBatchReviewItems(
  skills: SkillSummary[],
  mode: AiDescriptionMode,
  failures: SkillDescriptionJobFailure[] = [],
  remote = false,
): BatchSkillReviewItem[] {
  const failureById = new Map(failures.map((failure) => [failure.locationId, failure]));
  return skills.map((skill) => {
    const localizations = localizationsForSkill(skill);
    const manual = localizations.find((localization) => localization.mode === "manual");
    const localization = localizations.find((candidate) => candidate.mode === mode);
    if (manual) {
      return {
        skill,
        category: "protected",
        reason: "manual",
        selectable: false,
        selectedByDefault: false,
        requiresForce: false,
        localization: manual,
      };
    }
    if (isEffectivelyChinese(skill.description)) {
      return {
        skill,
        category: "protected",
        reason: "notNeeded",
        selectable: false,
        selectedByDefault: false,
        requiresForce: false,
      };
    }
    if (!skill.description.trim() && (mode === "translate" || remote)) {
      return {
        skill,
        category: "protected",
        reason: mode === "translate" ? "noSource" : "remoteBodyBlocked",
        selectable: false,
        selectedByDefault: false,
        requiresForce: false,
        localization,
      };
    }

    const failure = failureById.get(skill.id);
    if (failure) {
      return {
        skill,
        category: "retry",
        reason: "failed",
        selectable: true,
        selectedByDefault: true,
        requiresForce: localization?.status === "ready" || isEffectivelyChinese(skill.description),
        localization,
        failure,
      };
    }
    if (localization?.status === "stale") {
      return {
        skill,
        category: "needs",
        reason: "stale",
        selectable: true,
        selectedByDefault: true,
        requiresForce: false,
        localization,
      };
    }
    if (localization?.status === "ready") {
      return {
        skill,
        category: "translated",
        reason: "ready",
        selectable: true,
        selectedByDefault: false,
        requiresForce: true,
        localization,
      };
    }
    return {
      skill,
      category: "needs",
      reason: "missing",
      selectable: true,
      selectedByDefault: true,
      requiresForce: false,
    };
  });
}

export function defaultBatchSelection(
  items: BatchSkillReviewItem[],
  preset: "recommended" | "failures" = "recommended",
) {
  return new Set(items
    .filter((item) => item.selectable && (
      preset === "failures" ? item.category === "retry" : item.selectedByDefault
    ))
    .map((item) => item.skill.id));
}

export function batchForceRequired(items: BatchSkillReviewItem[], selectedIds: ReadonlySet<string>) {
  return items.some((item) => selectedIds.has(item.skill.id) && item.requiresForce);
}

function isEffectivelyChinese(value: string) {
  const meaningful = [...value].filter((character) => !/\s/u.test(character) && !(/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/u.test(character))).length;
  if (!meaningful) return false;
  const chinese = [...value].filter((character) => /\p{Script=Han}/u.test(character)).length;
  return chinese >= 2 && chinese * 3 >= meaningful;
}

function BatchGroupCheckbox({
  selected,
  total,
  label,
  disabled = false,
  onChange,
}: {
  selected: number;
  total: number;
  label: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const checked = total > 0 && selected === total;
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = selected > 0 && selected < total;
  }, [selected, total]);
  return (
    <input
      ref={inputRef}
      type="checkbox"
      checked={checked}
      disabled={disabled || !total}
      aria-label={label}
      aria-checked={selected > 0 && selected < total ? "mixed" : checked}
      onChange={(event) => onChange(event.currentTarget.checked)}
    />
  );
}

export function SkillDescriptionBatchDialog({
  open,
  onClose,
  filteredSkills,
  allSkills,
  project,
}: {
  open: boolean;
  onClose: () => void;
  filteredSkills: SkillSummary[];
  allSkills: SkillSummary[];
  project: Project | null;
}) {
  const { locale, t } = useI18n();
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDivElement>(null);
  const modeInitializedRef = useRef(false);
  const settingsQuery = useQuery({ queryKey: ["ai-description-settings"], queryFn: desktopApi.getAiDescriptionSettings, enabled: open });
  const [scope, setScope] = useState<"filtered" | "project" | "all">("filtered");
  const [mode, setMode] = useState<AiDescriptionMode>("summarize");
  const [remoteConfirmed, setRemoteConfirmed] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [reviewJob, setReviewJob] = useState<DescriptionJob | null>(null);
  const [selectionPreset, setSelectionPreset] = useState<"recommended" | "failures">("recommended");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [reviewQuery, setReviewQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<BatchSkillCategory | "all" | "recommended">("all");
  const selectionContextRef = useRef("");
  const selectionFocusContextRef = useRef("");
  const reviewedTerminalJobRef = useRef<string | null>(null);
  const submissionLockRef = useRef(false);
  const refreshedTerminalJobsRef = useRef(new Set<string>());
  const [inventoryRefreshing, setInventoryRefreshing] = useState(false);
  const [inventoryRefreshError, setInventoryRefreshError] = useState(false);
  const [inventoryRefreshAttempt, setInventoryRefreshAttempt] = useState(0);

  const latestJobQuery = useQuery({
    queryKey: ["skill-description-job", "dialog-latest"],
    queryFn: () => desktopApi.getSkillDescriptionJob(),
    enabled: open && !jobId,
    staleTime: 0,
    refetchOnMount: "always",
  });

  useEffect(() => {
    if (!settingsQuery.data || modeInitializedRef.current) return;
    modeInitializedRef.current = true;
    setMode(settingsQuery.data.defaultMode);
  }, [settingsQuery.data]);

  useEffect(() => {
    if (!open) return undefined;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableSelector = [
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");
    const focusFirst = window.requestAnimationFrame(() => {
      const preferred = dialogRef.current?.querySelector<HTMLElement>("[data-batch-initial-focus]");
      (preferred ?? dialogRef.current?.querySelector<HTMLElement>(focusableSelector))?.focus();
    });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector)]
        .filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.cancelAnimationFrame(focusFirst);
      window.removeEventListener("keydown", onKey);
      previouslyFocused?.focus();
    };
  }, [onClose, open]);

  const scopeSkills = useMemo(() => {
    if (scope === "filtered") return filteredSkills;
    if (scope === "project" && project) return allSkills.filter((skill) => skill.projectId === project.id);
    return allSkills;
  }, [allSkills, filteredSkills, project, scope]);

  const latestTerminalJob = latestJobQuery.data && terminalJob(latestJobQuery.data)
    ? latestJobQuery.data
    : null;
  const failureSourceJob = reviewJob ?? latestTerminalJob;
  const terminalReviewJob = !jobId ? failureSourceJob : null;
  const terminalInventoryReady = !terminalReviewJob
    || refreshedTerminalJobsRef.current.has(terminalReviewJob.id);
  const remoteProvider = isRemoteProvider(settingsQuery.data);
  const applicableFailures = useMemo(() => {
    if (!failureSourceJob || failureSourceJob.mode !== mode) return [];
    const skillsById = new Map(scopeSkills.map((skill) => [skill.id, skill]));
    return failureSourceJob.failures.filter((failure) => {
      const skill = skillsById.get(failure.locationId);
      if (!skill) return true;
      const localization = localizationsForSkill(skill).find((candidate) => candidate.mode === mode);
      return !localization?.generatedAt
        || !failureSourceJob.finishedAt
        || localization.generatedAt < failureSourceJob.finishedAt;
    });
  }, [failureSourceJob, mode, scopeSkills]);
  const reviewItems = useMemo(
    () => buildBatchReviewItems(scopeSkills, mode, applicableFailures, remoteProvider),
    [applicableFailures, mode, remoteProvider, scopeSkills],
  );
  const reviewInventoryFingerprint = useMemo(
    () => reviewItems
      .map((item) => `${item.skill.id}\u0000${item.category}\u0000${item.reason}\u0000${item.selectable ? 1 : 0}\u0000${item.localization?.generatedAt ?? 0}`)
      .sort()
      .join("\u0001"),
    [reviewItems],
  );

  useEffect(() => {
    const latest = latestJobQuery.data;
    if (!open || jobId || !latest || terminalJob(latest)) return;
    setJobId(latest.id);
    queryClient.setQueryData(["skill-description-job", latest.id], latest);
  }, [jobId, latestJobQuery.data, open, queryClient]);

  useEffect(() => {
    if (!open || !terminalReviewJob || refreshedTerminalJobsRef.current.has(terminalReviewJob.id)) {
      return undefined;
    }
    let cancelled = false;
    setInventoryRefreshError(false);
    setInventoryRefreshing(true);
    void invalidateSkillDescriptions(queryClient)
      .then(() => {
        if (cancelled) return;
        refreshedTerminalJobsRef.current.add(terminalReviewJob.id);
        selectionContextRef.current = "";
        setInventoryRefreshing(false);
      })
      .catch(() => {
        if (cancelled) return;
        setInventoryRefreshing(false);
        setInventoryRefreshError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [inventoryRefreshAttempt, open, queryClient, terminalReviewJob]);

  useEffect(() => {
    if (!open || jobId || inventoryRefreshing || settingsQuery.isLoading || !terminalInventoryReady || (latestJobQuery.isLoading && !reviewJob)) return;
    const context = `${scope}\u0000${mode}\u0000${remoteProvider ? "remote" : "local"}\u0000${failureSourceJob?.id ?? "fresh"}\u0000${selectionPreset}\u0000${reviewInventoryFingerprint}`;
    if (selectionContextRef.current === context) return;
    selectionContextRef.current = context;
    setSelectedIds(defaultBatchSelection(reviewItems, selectionPreset));
    setCategoryFilter(selectionPreset === "failures" ? "retry" : "all");
    setReviewQuery("");
  }, [failureSourceJob?.id, inventoryRefreshing, jobId, latestJobQuery.isLoading, mode, open, remoteProvider, reviewInventoryFingerprint, reviewItems, reviewJob, scope, selectionPreset, settingsQuery.isLoading, terminalInventoryReady]);

  useEffect(() => {
    const selectableIds = new Set(reviewItems.filter((item) => item.selectable).map((item) => item.skill.id));
    setSelectedIds((current) => {
      if ([...current].every((id) => selectableIds.has(id))) return current;
      return new Set([...current].filter((id) => selectableIds.has(id)));
    });
  }, [reviewItems]);

  const selectedItems = useMemo(
    () => reviewItems.filter((item) => selectedIds.has(item.skill.id) && item.selectable),
    [reviewItems, selectedIds],
  );
  const selectedSkills = useMemo(() => selectedItems.map((item) => item.skill), [selectedItems]);
  const force = batchForceRequired(reviewItems, selectedIds);
  const reviewCounts = useMemo(() => ({
    retry: reviewItems.filter((item) => item.category === "retry").length,
    needs: reviewItems.filter((item) => item.category === "needs").length,
    translated: reviewItems.filter((item) => item.category === "translated").length,
    protected: reviewItems.filter((item) => item.category === "protected").length,
  }), [reviewItems]);
  const selectedCounts = useMemo(() => ({
    retry: selectedItems.filter((item) => item.category === "retry").length,
    needs: selectedItems.filter((item) => item.category === "needs").length,
    replace: selectedItems.filter((item) => item.requiresForce).length,
  }), [selectedItems]);
  const normalizedReviewQuery = reviewQuery.trim().toLocaleLowerCase();
  const searchedItems = useMemo(() => reviewItems.filter((item) => {
    if (!normalizedReviewQuery) return true;
    return `${item.skill.name}\n${item.skill.displayName}\n${item.skill.description}\n${item.localization?.text ?? ""}\n${item.skill.agentType}`
      .toLocaleLowerCase()
      .includes(normalizedReviewQuery);
  }), [normalizedReviewQuery, reviewItems]);
  const visibleCategories: BatchSkillCategory[] = categoryFilter === "all"
    ? ["retry", "needs", "translated", "protected"]
    : categoryFilter === "recommended"
      ? ["retry", "needs"]
      : [categoryFilter];

  const changeScope = (next: "filtered" | "project" | "all") => {
    selectionContextRef.current = "";
    setScope(next);
  };
  const changeMode = (next: AiDescriptionMode) => {
    selectionContextRef.current = "";
    setSelectionPreset("recommended");
    setMode(next);
  };
  const toggleSelected = (id: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const setItemsSelected = (items: BatchSkillReviewItem[], checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const item of items) {
        if (!item.selectable) continue;
        if (checked) next.add(item.skill.id);
        else next.delete(item.skill.id);
      }
      return next;
    });
  };

  const targetFingerprint = useMemo(
    () => [
      settingsQuery.data?.provider ?? "",
      settingsQuery.data?.openaiModel ?? "",
      settingsQuery.data?.compatibleBaseUrl ?? "",
      settingsQuery.data?.compatibleModel ?? "",
      mode,
      force ? "force" : "default",
      ...selectedSkills
        .map((skill) => `${skill.id}\u0000${skill.name}\u0000${skill.description}`)
        .sort(),
    ].join("\u0001"),
    [
      force,
      mode,
      settingsQuery.data?.compatibleBaseUrl,
      settingsQuery.data?.compatibleModel,
      settingsQuery.data?.openaiModel,
      settingsQuery.data?.provider,
      selectedSkills,
    ],
  );
  const remoteBodySkipped = remoteProvider
    ? reviewItems.filter((item) => item.reason === "noSource" || item.reason === "remoteBodyBlocked").length
    : 0;
  const payloadChars = selectedSkills.reduce((total, skill) => total + skill.name.length + skill.description.length, 0);
  const remotePayloadChars = selectedSkills
    .filter((skill) => skill.description.trim())
    .reduce((total, skill) => total + skill.name.length + skill.description.length, 0);

  useEffect(() => {
    setRemoteConfirmed(false);
  }, [open, scope, targetFingerprint]);

  const startMutation = useMutation({
    mutationFn: async () => {
      const expectedSourceHashes = isRemoteProvider(settingsQuery.data)
        ? Object.fromEntries(await Promise.all(
            selectedSkills
              .filter((skill) => skill.description.trim())
              .map(async (skill) => [
                skill.id,
                await sha256Text(remoteConfirmationPayload(
                  settingsQuery.data as AiDescriptionSettings,
                  mode,
                  skill.name,
                  "description",
                  skill.description,
                )),
              ] as const),
          ))
        : undefined;
      return desktopApi.startSkillDescriptionJob({
        locationIds: selectedSkills.map((skill) => skill.id),
        targetLocale: TARGET_LOCALE,
        mode,
        force,
        expectedSourceHashes,
      });
    },
    onSuccess: (job) => {
      setReviewJob(null);
      setJobId(job.id);
      queryClient.setQueryData(["skill-description-job", job.id], job);
      queryClient.setQueryData(["skill-description-job", "active"], job);
    },
    onSettled: () => {
      submissionLockRef.current = false;
    },
  });

  const startSelectedBatch = () => {
    if (submissionLockRef.current) return;
    submissionLockRef.current = true;
    startMutation.mutate();
  };

  useEffect(() => {
    if (!startMutation.isPending) startMutation.reset();
  // Reset only stale submission feedback when the disclosed target set changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetFingerprint]);

  const jobQuery = useQuery({
    queryKey: ["skill-description-job", jobId],
    queryFn: () => desktopApi.getSkillDescriptionJob(jobId ?? undefined),
    enabled: Boolean(jobId),
    refetchInterval: (query) => terminalJob(query.state.data) ? false : 700,
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => desktopApi.cancelSkillDescriptionJob(id),
    onSuccess: (job) => {
      queryClient.setQueryData(["skill-description-job", jobId], job);
      queryClient.setQueryData(["skill-description-job", "active"], job);
    },
  });

  useEffect(() => {
    const currentJob = jobQuery.data;
    if (!currentJob) return undefined;
    queryClient.setQueryData(["skill-description-job", "active"], currentJob);
    if (!terminalJob(currentJob) || reviewedTerminalJobRef.current === currentJob.id) return undefined;
    reviewedTerminalJobRef.current = currentJob.id;
    setReviewJob(currentJob);
    setSelectionPreset(currentJob.status === "completed" && currentJob.failures.length ? "failures" : "recommended");
    selectionContextRef.current = "";
    setRemoteConfirmed(false);
    setReviewQuery("");
    setJobId(null);
    return undefined;
  }, [jobQuery.data, queryClient]);

  const selectionFocusContext = open
    && !jobId
    && !inventoryRefreshing
    && !inventoryRefreshError
    && terminalInventoryReady
    && !settingsQuery.isLoading
    && !(latestJobQuery.isLoading && !reviewJob)
    ? failureSourceJob?.id ?? "fresh"
    : "";
  useEffect(() => {
    if (!selectionFocusContext || selectionFocusContextRef.current === selectionFocusContext) return undefined;
    selectionFocusContextRef.current = selectionFocusContext;
    const frame = window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>("[data-batch-initial-focus]")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectionFocusContext]);

  if (!open) return null;
  const settings = settingsQuery.data;
  const remote = remoteProvider;
  const remoteDomain = remoteProviderDomain(settings);
  const job = jobId ? jobQuery.data : null;
  const running = Boolean(job && !terminalJob(job));
  const progress = job?.total ? Math.round((job.completed / job.total) * 100) : 0;
  const batchLimit = remote ? 50 : 200;
  const overLimit = selectedSkills.length > batchLimit;
  const reconnecting = !jobId && Boolean(latestJobQuery.data && !terminalJob(latestJobQuery.data));

  const categoryMeta: Record<BatchSkillCategory, { label: string; description: string }> = {
    retry: { label: t("skills.batch.group.retry"), description: t("skills.batch.group.retryDescription") },
    needs: { label: t("skills.batch.group.needs"), description: t("skills.batch.group.needsDescription") },
    translated: { label: t("skills.batch.group.translated"), description: t("skills.batch.group.translatedDescription") },
    protected: { label: t("skills.batch.group.protected"), description: t("skills.batch.group.protectedDescription") },
  };
  const actionLabel = (item: BatchSkillReviewItem) => {
    if (item.reason === "failed") return t("skills.batch.action.retry");
    if (item.reason === "manual") return t("skills.batch.action.manualProtected");
    if (item.reason === "notNeeded") return t("skills.batch.action.alreadyChinese");
    if (item.reason === "noSource") return t("skills.batch.action.noSource");
    if (item.reason === "remoteBodyBlocked") return t("skills.batch.action.remoteBodyBlocked");
    if (item.reason === "stale") return mode === "translate" ? t("skills.batch.action.updateTranslation") : t("skills.batch.action.updateSummary");
    if (item.reason === "ready") return mode === "translate" ? t("skills.batch.action.retranslate") : t("skills.batch.action.resummarize");
    return mode === "translate" ? t("skills.batch.action.translate") : t("skills.batch.action.summarize");
  };
  return createPortal((
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div ref={dialogRef} className="dialog batch-description-dialog" role="dialog" aria-modal="true" aria-labelledby="batch-description-title" aria-describedby="batch-description-copy" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <div><span className="dialog-icon"><Languages size={19} /></span><div><h2 id="batch-description-title">{t("skills.batch.title")}</h2><p id="batch-description-copy">{t("skills.batch.description")}</p></div></div>
          <button type="button" className="dialog-close" onClick={onClose} aria-label={t("skills.common.close")}><X size={17} /></button>
        </div>

        {inventoryRefreshError && !job ? (
          <div className="batch-inventory-error" role="alert"><AlertTriangle size={20} /><div><strong>{t("skills.batch.refreshFailed")}</strong><span>{t("skills.batch.refreshFailedDescription")}</span></div><button type="button" className="button secondary small" onClick={() => { setInventoryRefreshError(false); setInventoryRefreshAttempt((value) => value + 1); }}>{t("skills.batch.retryRefresh")}</button></div>
        ) : (latestJobQuery.isLoading || settingsQuery.isLoading || reconnecting || inventoryRefreshing || !terminalInventoryReady) && !job ? (
          <div className="batch-inventory-loading" role="status"><LoaderCircle className="spin" size={18} /><span>{t("skills.batch.refreshingInventory")}</span></div>
        ) : job ? (
          <div className="batch-job-view">
            <div className={`batch-job-orb ${job.status}`}>
              {running ? <LoaderCircle className="spin" size={24} /> : job.status === "completed" ? <CheckCircle2 size={24} /> : <AlertTriangle size={24} />}
            </div>
            <div className="batch-job-summary">
              <strong>{running ? t("skills.batch.running") : job.status === "completed" ? t("skills.batch.completed") : job.status === "cancelled" ? t("skills.batch.cancelled") : t("skills.batch.incomplete")}</strong>
              <p>{job.completed} / {job.total} · {t("skills.batch.succeeded")} {job.succeeded} · {t("skills.batch.skipped")} {job.skipped} · {t("skills.batch.failed")} {job.failed}</p>
            </div>
            <div className="batch-progress-track" role="progressbar" aria-label={t("skills.batch.progressLabel")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={t("skills.batch.progressAria", { completed: job.completed, total: job.total, failed: job.failed })}><span style={{ width: `${progress}%` }} /></div>
            {job.currentLocationId && <p className="batch-current-item"><Sparkles size={13} />{t("skills.batch.currentItem", { name: allSkills.find((skill) => skill.id === job.currentLocationId)?.displayName ?? job.currentLocationId })}</p>}
            {job.failures.length > 0 && <details className="batch-failures"><summary>{t("skills.batch.viewFailures", { count: job.failures.length })}</summary><ul>{job.failures.map((failure) => <li key={failure.locationId}><strong>{allSkills.find((skill) => skill.id === failure.locationId)?.displayName ?? failure.locationId}</strong><span>{failure.code} · {failure.message}</span></li>)}</ul></details>}
            <div className="dialog-footer">
              {running && <button type="button" className="button secondary" onClick={() => cancelMutation.mutate(job.id)} disabled={cancelMutation.isPending}>{t("skills.batch.cancelRemaining")}</button>}
              <button type="button" className="button primary" onClick={onClose}>{running ? t("skills.batch.continueBackground") : t("skills.common.done")}</button>
            </div>
          </div>
        ) : (
          <div className="batch-description-form">
            <a className="batch-skip-link" href="#batch-description-actions">{t("skills.batch.skipToActions")}</a>
            {reviewJob && <div className={`batch-review-result ${reviewJob.failed ? "has-failures" : reviewJob.status}`} role="status"><span>{reviewJob.failed ? <AlertTriangle size={17} /> : <CheckCircle2 size={17} />}</span><div><strong>{reviewJob.status === "completed" ? t("skills.batch.completed") : reviewJob.status === "cancelled" ? t("skills.batch.cancelled") : t("skills.batch.incomplete")}</strong><small>{t("skills.batch.succeeded")} {reviewJob.succeeded} · {t("skills.batch.skipped")} {reviewJob.skipped} · {t("skills.batch.failed")} {reviewJob.failed}</small></div></div>}
            <fieldset className="batch-scope-options"><legend>{t("skills.batch.scope")}</legend>
              <label className={scope === "filtered" ? "active" : ""}><input type="radio" name="batch-scope" checked={scope === "filtered"} onChange={() => changeScope("filtered")} disabled={startMutation.isPending} /><span><strong>{t("skills.batch.filtered")}</strong><small>{t("skills.common.items", { count: filteredSkills.length })}</small></span></label>
              <label className={scope === "project" ? "active" : ""}><input type="radio" name="batch-scope" checked={scope === "project"} onChange={() => changeScope("project")} disabled={!project || startMutation.isPending} /><span><strong>{t("skills.batch.currentProject")}</strong><small>{project?.name ?? t("skills.batch.selectProject")}</small></span></label>
              <label className={scope === "all" ? "active" : ""}><input type="radio" name="batch-scope" checked={scope === "all"} onChange={() => changeScope("all")} disabled={startMutation.isPending} /><span><strong>{t("skills.batch.allSkills")}</strong><small>{t("skills.common.items", { count: allSkills.length })}</small></span></label>
            </fieldset>
            <div className="batch-review-controls">
              <label className="form-field batch-mode-field"><span>{t("skills.ai.generationMode")}</span><select value={mode} onChange={(event) => changeMode(event.currentTarget.value as AiDescriptionMode)} disabled={startMutation.isPending}><option value="summarize">{t("skills.ai.modeSummariseLong")}</option><option value="translate">{t("skills.ai.mode.translate")}</option></select></label>
              <label className="batch-review-search"><Search size={14} /><input data-batch-initial-focus type="search" value={reviewQuery} onChange={(event) => setReviewQuery(event.currentTarget.value)} placeholder={t("skills.batch.searchPlaceholder")} aria-label={t("skills.batch.searchPlaceholder")} /></label>
              <div className="batch-review-quick-actions"><button type="button" className="button ghost small" onClick={() => setSelectedIds(defaultBatchSelection(reviewItems))} disabled={startMutation.isPending}>{t("skills.batch.selectRecommended")}</button><button type="button" className="button ghost small" onClick={() => setSelectedIds(new Set())} disabled={startMutation.isPending}>{t("skills.batch.clearSelection")}</button></div>
            </div>

            <div className="batch-category-tabs" role="group" aria-label={t("skills.batch.categoryFilter")}>{([
              ["all", t("skills.batch.filter.all"), reviewItems.length],
              ["recommended", t("skills.batch.filter.recommended"), reviewCounts.retry + reviewCounts.needs],
              ["retry", t("skills.batch.filter.retry"), reviewCounts.retry],
              ["needs", t("skills.batch.filter.needs"), reviewCounts.needs],
              ["translated", t("skills.batch.filter.translated"), reviewCounts.translated],
              ["protected", t("skills.batch.filter.protected"), reviewCounts.protected],
            ] as const).map(([value, label, count]) => <button key={value} type="button" aria-pressed={categoryFilter === value} className={categoryFilter === value ? "active" : ""} onClick={() => setCategoryFilter(value)}><span>{label}</span><strong>{count}</strong></button>)}</div>

            <div className="batch-skill-groups">
              {visibleCategories.map((category) => {
                const items = searchedItems.filter((item) => item.category === category);
                if (!items.length) return null;
                const selectableItems = items.filter((item) => item.selectable);
                const selectedCount = selectableItems.filter((item) => selectedIds.has(item.skill.id)).length;
                return <section className={`batch-skill-group ${category}`} key={category} aria-labelledby={`batch-group-${category}`}>
                  <div className="batch-skill-group-header">
                    <BatchGroupCheckbox selected={selectedCount} total={selectableItems.length} label={t("skills.batch.selectGroupAria", { group: categoryMeta[category].label })} disabled={startMutation.isPending} onChange={(checked) => setItemsSelected(selectableItems, checked)} />
                    <div><strong id={`batch-group-${category}`}>{categoryMeta[category].label}</strong><small>{categoryMeta[category].description}</small></div>
                    <span>{items.length}</span>
                  </div>
                  <div className="batch-skill-list">{items.map((item) => {
                    const action = actionLabel(item);
                    const preview = item.localization?.text ?? item.skill.description;
                    const stateId = `batch-skill-state-${item.skill.id}`;
                    return <label className={`batch-skill-row ${item.category} ${selectedIds.has(item.skill.id) ? "selected" : ""}`} key={item.skill.id}>
                      <input type="checkbox" checked={selectedIds.has(item.skill.id)} disabled={!item.selectable || startMutation.isPending} onChange={(event) => toggleSelected(item.skill.id, event.currentTarget.checked)} aria-label={t("skills.batch.skillSelectionAria", { name: item.skill.displayName, action })} aria-describedby={stateId} />
                      <span className="batch-skill-copy"><strong title={item.skill.displayName}>{item.skill.displayName}</strong><small>{item.skill.agentType} · {item.skill.scopeKind}</small>{preview && <span title={preview}>{preview}</span>}</span>
                      <span id={stateId} className="batch-skill-state"><strong>{t(`skills.batch.status.${item.reason}`)}</strong><small title={item.failure?.message}>{action}{item.failure ? ` · ${item.failure.code}` : ""}</small></span>
                    </label>;
                  })}</div>
                </section>;
              })}
              {!visibleCategories.some((category) => searchedItems.some((item) => item.category === category)) && <div className="batch-empty-state"><Search size={18} /><span>{t("skills.batch.noMatches")}</span></div>}
            </div>

            <div className="batch-selection-summary" aria-live="polite">
              <div><strong>{t("skills.batch.selected", { count: selectedSkills.length })}</strong><span>{t("skills.batch.selectedBreakdown", { retry: selectedCounts.retry, process: selectedCounts.needs, replace: selectedCounts.replace })}</span></div>
              <span>{t("skills.batch.tokenEstimate", { count: Math.ceil(payloadChars / 3).toLocaleString(locale) })}</span>
            </div>
            {selectedCounts.replace > 0 && <div className="batch-replace-notice"><RefreshCw size={14} /><span>{t("skills.batch.replaceNotice", { count: selectedCounts.replace })}</span></div>}
            {remote ? <div className="remote-confirm-card"><Cloud size={17} /><div><strong>{t("skills.batch.connectRemote", { domain: remoteDomain })}</strong><p>{t("skills.batch.remoteDisclosure", { characters: remotePayloadChars.toLocaleString(locale), tokens: Math.ceil(remotePayloadChars / 3).toLocaleString(locale), skipped: remoteBodySkipped })}</p><label><input type="checkbox" checked={remoteConfirmed} onChange={(event) => setRemoteConfirmed(event.currentTarget.checked)} /><span>{t("skills.batch.remoteConfirm")}</span></label></div></div> : <div className="local-batch-card"><Server size={16} /><span><strong>{t("skills.batch.localProcessing")}</strong>{t("skills.batch.localDisclosure", { endpoint: settings?.localEndpoint ?? t("skills.batch.localLoopback") })}</span></div>}
            {startMutation.isError && <div className="form-error" role="alert"><AlertTriangle size={14} />{startMutation.error.message}</div>}
            {!settings?.enabled && <div className="form-error"><Info size={14} />{t("skills.ai.enableFirst")}</div>}
            {overLimit && <div className="form-error" role="alert"><AlertTriangle size={14} />{t("skills.batch.limitExceeded", { count: selectedSkills.length, limit: batchLimit })}</div>}
            <div id="batch-description-actions" className="dialog-footer" tabIndex={-1}><button type="button" className="button secondary" onClick={onClose}>{t("skills.common.cancel")}</button><button type="button" className="button primary" onClick={startSelectedBatch} disabled={!selectedSkills.length || overLimit || !providerReady(settings) || (remote && !remoteConfirmed) || startMutation.isPending}>{startMutation.isPending ? t("skills.batch.creating") : t("skills.batch.startSelected", { count: selectedSkills.length })}</button></div>
          </div>
        )}
      </div>
    </div>
  ), document.body);
}
