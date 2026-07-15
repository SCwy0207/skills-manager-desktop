import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertOctagon,
  AlertTriangle,
  Binary,
  CheckCircle2,
  EyeOff,
  FileSearch,
  Files,
  HardDrive,
  Link2Off,
  RefreshCw,
  ScanSearch,
  ShieldCheck,
} from "lucide-react";

import { ErrorState } from "../components/Common";
import { useI18n } from "../i18n/i18n";
import { desktopApi } from "../lib/ipc";
import type { SecurityFinding, SkillSummary } from "../types";

const severityOrder = ["critical", "high", "medium", "low"] as const;
export function SkillSecurityPanel({ skill }: { skill: SkillSummary }) {
  const { locale, t } = useI18n();
  const queryClient = useQueryClient();
  const historyQuery = useQuery({
    queryKey: ["skill-security", skill.id],
    queryFn: () => desktopApi.getSkillSecurityScan(skill.id),
  });
  const scanMutation = useMutation({
    mutationFn: () => desktopApi.scanSkillSecurity(skill.id),
    onSuccess: async (result) => {
      queryClient.setQueryData(["skill-security", skill.id], result);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["skill", skill.id] }),
        queryClient.invalidateQueries({ queryKey: ["skills"] }),
        queryClient.invalidateQueries({ queryKey: ["audit-logs"] }),
      ]);
    },
  });
  const result = scanMutation.data ?? historyQuery.data ?? null;

  const groupedFindings = useMemo(() => {
    const findings = result?.findings ?? [];
    return severityOrder
      .map((severity) => ({
        severity,
        findings: findings.filter((finding) => finding.severity.toLocaleLowerCase() === severity),
      }))
      .filter((group) => group.findings.length > 0);
  }, [result?.findings]);

  if (historyQuery.isLoading && !result) {
    return (
      <div className="security-scanning" role="status">
        <span className="security-scan-animation"><ShieldCheck size={28} /><span /></span>
        <h2>{t("skills.security.loading")}</h2>
      </div>
    );
  }

  if (!result && !scanMutation.isPending && !scanMutation.isError && !historyQuery.isError) {
    return (
      <div className="security-empty">
        <span className="security-empty-icon"><ShieldCheck size={27} /></span>
        <h2>{t("skills.security.title")}</h2>
        <p>{t("skills.security.description")}</p>
        <div className="security-guarantees">
          <span><FileSearch size={13} /> {t("skills.security.localOnly")}</span>
          <span><Link2Off size={13} /> {t("skills.security.noExternalLinks")}</span>
          <span><EyeOff size={13} /> {t("skills.security.redactedEvidence")}</span>
        </div>
        <button type="button" className="button primary" onClick={() => scanMutation.mutate()}>
          <ScanSearch size={15} /> {t("skills.security.run")}
        </button>
        <small>{t("skills.security.advisory")}</small>
      </div>
    );
  }

  if (scanMutation.isPending) {
    return (
      <div className="security-scanning" role="status">
        <span className="security-scan-animation">
          <ShieldCheck size={28} />
          <span />
        </span>
        <h2>{t("skills.security.scanning")}</h2>
        <p>{t("skills.security.scanningDescription")}</p>
        <span className="security-progress"><span /></span>
        <small>{t("skills.security.neverExecutes")}</small>
      </div>
    );
  }

  if ((scanMutation.isError || historyQuery.isError) && !result) {
    return (
      <div className="security-error-wrap">
        <ErrorState
          error={scanMutation.error ?? historyQuery.error}
          onRetry={() => scanMutation.isError ? scanMutation.mutate() : void historyQuery.refetch()}
        />
        <p>{t("skills.security.failureSafe")}</p>
      </div>
    );
  }

  if (!result) return null;
  const skippedTotal =
    result.skippedBinaryFiles + result.skippedOversizedFiles + result.skippedLinks;
  const status = result.status.toLocaleLowerCase();

  return (
    <div className="security-results">
      {scanMutation.isError && (
        <div className="form-error"><AlertTriangle size={14} />{scanMutation.error.message}</div>
      )}
      <header className="security-results-header">
        <div>
          <span className={`security-result-icon ${status}`}>
            {status === "safe" ? <CheckCircle2 size={23} /> : status === "blocked" ? <AlertOctagon size={23} /> : <AlertTriangle size={23} />}
          </span>
          <div>
            <span className="security-result-kicker">
              {t("skills.security.completed")} · {new Date(result.scannedAt * 1000).toLocaleString(locale, { hour12: false })}
            </span>
            <h2>{t(`skills.security.${status}`)}</h2>
            <p>{result.findings.length ? t("skills.security.findingsFound", { count: result.findings.length }) : t("skills.security.noPatterns")}</p>
          </div>
        </div>
        <button type="button" className="button secondary small" onClick={() => scanMutation.mutate()}>
          <RefreshCw size={13} /> {t("skills.security.rescan")}
        </button>
      </header>

      <div className="security-stats">
        <SecurityStat icon={<Files size={15} />} label={t("skills.security.scannedFiles")} value={String(result.scannedFiles)} />
        <SecurityStat icon={<HardDrive size={15} />} label={t("skills.security.scannedContent")} value={formatBytes(result.scannedBytes)} />
        <SecurityStat icon={<AlertTriangle size={15} />} label={t("skills.security.riskFindings")} value={String(result.findings.length)} tone={result.findings.length ? "warning" : "safe"} />
        <SecurityStat icon={<Binary size={15} />} label={t("skills.security.skipped")} value={String(skippedTotal)} tone={skippedTotal ? "warning" : undefined} />
      </div>

      {skippedTotal > 0 && (
        <div className="security-skip-note">
          <AlertTriangle size={13} />
          <span>
            {t("skills.security.skippedBreakdown", { binary: result.skippedBinaryFiles, oversized: result.skippedOversizedFiles, links: result.skippedLinks })}
          </span>
        </div>
      )}

      {result.findings.length === 0 ? (
        <div className="security-safe-result">
          <CheckCircle2 size={22} />
          <div><strong>{t("skills.security.noKnownRisks")}</strong><p>{t("skills.security.noKnownRisksDescription")}</p></div>
        </div>
      ) : (
        <div className="finding-groups">
          {groupedFindings.map((group) => (
            <section key={group.severity} className="finding-group">
              <div className="finding-group-heading">
                <span className={`severity-badge ${group.severity}`}>{t(`skills.security.severity.${group.severity}`)}</span>
                <span>{t("skills.common.items", { count: group.findings.length })}</span>
              </div>
              {group.findings.map((finding) => (
                <FindingCard key={finding.id} finding={finding} />
              ))}
            </section>
          ))}
        </div>
      )}

      <footer className="security-disclaimer">
        <ShieldCheck size={13} /> {t("skills.security.disclaimer")}
      </footer>
    </div>
  );
}

function SecurityStat({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: "safe" | "warning";
}) {
  return (
    <div className={`security-stat ${tone ?? ""}`}>
      <span>{icon}</span>
      <div><strong>{value}</strong><small>{label}</small></div>
    </div>
  );
}

function FindingCard({ finding }: { finding: SecurityFinding }) {
  const { t } = useI18n();
  const severity = finding.severity.toLocaleLowerCase();
  const ruleMessageKey = `skills.security.rule.${finding.ruleId}`;
  const translatedRuleMessage = t(ruleMessageKey);
  return (
    <article className={`finding-card ${severity}`}>
      <div className="finding-card-header">
        <code>{finding.ruleId}</code>
        {(finding.filePath || finding.line) && (
          <span title={finding.filePath ?? undefined}>
            {finding.filePath ?? t("skills.security.unknownFile")}{finding.line ? `:${finding.line}` : ""}
          </span>
        )}
      </div>
      <p>{translatedRuleMessage === ruleMessageKey ? finding.message : translatedRuleMessage}</p>
      {finding.evidenceRedacted && (
        <div className="finding-evidence">
          <span><EyeOff size={11} /> {t("skills.security.redacted")}</span>
          <pre>{finding.evidenceRedacted}</pre>
        </div>
      )}
    </article>
  );
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
