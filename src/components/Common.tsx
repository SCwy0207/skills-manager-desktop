import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import {
  AlertCircle,
  CheckCircle2,
  LoaderCircle,
  Search,
  X,
} from "lucide-react";
import { getCurrentLocale, translateNow, useI18n } from "../i18n/i18n";

export function IconButton({
  label,
  children,
  onClick,
  disabled,
  className = "",
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder,
  autoFocus = false,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  autoFocus?: boolean;
}) {
  const { t } = useI18n();
  const shortcutLabel =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
      ? "⌘ F"
      : "Ctrl F";

  return (
    <label className="search-field">
      <Search size={15} aria-hidden="true" />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          if (value) onChange("");
          else event.currentTarget.blur();
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        aria-keyshortcuts="Control+F Meta+F"
        autoFocus={autoFocus}
        spellCheck={false}
      />
      {value ? (
        <button type="button" aria-label={t("common.search.clear")} onClick={() => onChange("")}>
          <X size={14} />
        </button>
      ) : (
        <kbd>{shortcutLabel}</kbd>
      )}
    </label>
  );
}

/**
 * Gives desktop result lists the familiar Explorer-style arrow-key behavior.
 * Add `data-roving-list` to the container and `data-roving-item` to each row.
 */
export function handleRovingListKeyDown(
  event: ReactKeyboardEvent<HTMLButtonElement>,
) {
  const supportedKeys = ["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"];
  if (!supportedKeys.includes(event.key)) return;

  const list = event.currentTarget.closest<HTMLElement>("[data-roving-list]");
  const items = Array.from(
    list?.querySelectorAll<HTMLButtonElement>("[data-roving-item]") ?? [],
  ).filter((item) => !item.disabled);
  if (!items.length) return;

  const currentIndex = Math.max(0, items.indexOf(event.currentTarget));
  let nextIndex = currentIndex;
  if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = items.length - 1;
  else if (event.key === "ArrowDown") nextIndex = Math.min(items.length - 1, currentIndex + 1);
  else if (event.key === "ArrowUp") nextIndex = Math.max(0, currentIndex - 1);
  else if (event.key === "PageDown") nextIndex = Math.min(items.length - 1, currentIndex + 5);
  else if (event.key === "PageUp") nextIndex = Math.max(0, currentIndex - 5);

  event.preventDefault();
  const nextItem = items[nextIndex];
  nextItem.focus({ preventScroll: true });
  nextItem.scrollIntoView({ block: "nearest" });
  if (nextItem !== event.currentTarget) nextItem.click();
}

export function HighlightText({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (!needle) return <>{text}</>;
  const lowered = text.toLocaleLowerCase();
  const loweredNeedle = needle.toLocaleLowerCase();
  const fragments: ReactNode[] = [];
  let cursor = 0;
  let match = lowered.indexOf(loweredNeedle);
  let key = 0;
  while (match !== -1) {
    if (match > cursor) fragments.push(text.slice(cursor, match));
    const end = match + needle.length;
    fragments.push(<mark key={`${match}-${key++}`}>{text.slice(match, end)}</mark>);
    cursor = end;
    match = lowered.indexOf(loweredNeedle, cursor);
  }
  if (cursor < text.length) fragments.push(text.slice(cursor));
  return <>{fragments.length ? fragments : text}</>;
}

export function StateBadge({
  tone,
  children,
  dot = true,
}: {
  tone: "success" | "warning" | "danger" | "neutral" | "accent" | "purple";
  children: ReactNode;
  dot?: boolean;
}) {
  return (
    <span className={`state-badge state-${tone}`}>
      {dot && <span className="state-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

export function LoadingState({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <div className="center-state" role="status">
      <LoaderCircle className="spin" size={20} />
      <span>{label ?? t("common.loading")}</span>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-icon">{icon}</div>}
      <strong>{title}</strong>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  const message = error instanceof Error ? error.message : t("common.error.unknown");
  return (
    <div className="error-state" role="alert">
      <AlertCircle size={19} />
      <div>
        <strong>{t("common.error.title")}</strong>
        <p>{message}</p>
      </div>
      {onRetry && (
        <button type="button" className="button secondary small" onClick={onRetry}>
          {t("common.retry")}
        </button>
      )}
    </div>
  );
}

export function SuccessNotice({ children }: { children: ReactNode }) {
  return (
    <div className="inline-notice success">
      <CheckCircle2 size={15} />
      <span>{children}</span>
    </div>
  );
}

export function formatRelativeTime(timestamp: number) {
  const elapsed = Math.max(0, Date.now() - timestamp * 1000);
  const minute = 60_000;
  const hour = minute * 60;
  const day = hour * 24;
  if (elapsed < minute) return translateNow("common.time.now");
  if (elapsed < hour) {
    const count = Math.floor(elapsed / minute);
    return translateNow(count === 1 ? "common.time.minute" : "common.time.minutes", { count });
  }
  if (elapsed < day) {
    const count = Math.floor(elapsed / hour);
    return translateNow(count === 1 ? "common.time.hour" : "common.time.hours", { count });
  }
  if (elapsed < day * 7) {
    const count = Math.floor(elapsed / day);
    return translateNow(count === 1 ? "common.time.day" : "common.time.days", { count });
  }
  return new Intl.DateTimeFormat(getCurrentLocale(), {
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp * 1000));
}

export function formatDateTime(timestamp: number) {
  return new Intl.DateTimeFormat(getCurrentLocale(), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp * 1000));
}

export function compactPath(path: string, max = 54) {
  if (path.length <= max) return path;
  const separator = path.includes("\\") ? "\\" : "/";
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length < 3) return `…${path.slice(-(max - 1))}`;
  return `${parts[0]}${separator}…${separator}${parts.slice(-2).join(separator)}`;
}

export function SkeletonRows({ count = 5 }: { count?: number }) {
  return (
    <div className="skeleton-list" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div className="skeleton-row" key={index}>
          <span className="skeleton skeleton-icon" />
          <div>
            <span className="skeleton skeleton-title" />
            <span className="skeleton skeleton-text" />
          </div>
        </div>
      ))}
    </div>
  );
}
