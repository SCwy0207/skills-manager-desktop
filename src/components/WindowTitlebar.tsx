import { useCallback, useEffect, useRef, useState } from "react";
import type { Window as TauriWindow } from "@tauri-apps/api/window";

import { isTauriRuntime } from "../lib/ipc";
import { translateNow, useI18n } from "../i18n/i18n";
import { useUiStore } from "../store/ui";
import { BrandMark } from "./BrandMark";
import "./WindowTitlebar.css";

export interface WindowTitlebarProps {
  /** Product name shown in the native window chrome. */
  title?: string;
  /** Short local-build marker; pass an empty string to hide it. */
  edition?: string;
  className?: string;
}

type WindowAction = "minimize" | "toggleMaximize" | "close";

function confirmWindowClose() {
  const { criticalOperations, skillEditorDirty } = useUiStore.getState();
  const operationLabels = Object.values(criticalOperations);
  if (!operationLabels.length && !skillEditorDirty) return true;

  const warnings = [
    operationLabels.length
      ? translateNow("window.close.operation", {
          operations: operationLabels.join(translateNow("window.operationSeparator")),
        })
      : null,
    skillEditorDirty ? translateNow("window.close.unsaved") : null,
    translateNow("window.close.confirm"),
  ].filter(Boolean);
  return window.confirm(warnings.join("\n\n"));
}

/**
 * Compact, application-owned window chrome for the undecorated Tauri window.
 *
 * Tauri handles dragging and native double-click maximize through the
 * `data-tauri-drag-region` attribute. In a browser preview the titlebar remains
 * visible, while window actions intentionally become safe no-ops.
 */
export function WindowTitlebar({
  title = "Skills Manager",
  edition,
  className = "",
}: WindowTitlebarProps) {
  const { t } = useI18n();
  const appWindowRef = useRef<TauriWindow | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);

  const resolveWindow = useCallback(async () => {
    if (!isTauriRuntime) return null;
    if (appWindowRef.current) return appWindowRef.current;

    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    appWindowRef.current = getCurrentWindow();
    return appWindowRef.current;
  }, []);

  const syncMaximizedState = useCallback(async () => {
    const appWindow = await resolveWindow();
    if (!appWindow) return;

    try {
      setIsMaximized(await appWindow.isMaximized());
    } catch {
      // The component can also render in an ordinary browser during UI review.
    }
  }, [resolveWindow]);

  useEffect(() => {
    if (!isTauriRuntime) return undefined;

    let disposed = false;
    const stopListening: Array<() => void> = [];

    void (async () => {
      const appWindow = await resolveWindow();
      if (!appWindow || disposed) return;

      await syncMaximizedState();
      const unlistenResize = await appWindow.onResized(() => {
        if (!disposed) void syncMaximizedState();
      });
      const unlistenClose = await appWindow.onCloseRequested(async (event) => {
        const { criticalOperations, skillEditorDirty } = useUiStore.getState();
        if (!Object.keys(criticalOperations).length && !skillEditorDirty) return;
        event.preventDefault();
        if (!confirmWindowClose()) return;
        try {
          await appWindow.destroy();
        } catch (error) {
          console.warn("Unable to close the desktop window.", error);
        }
      });

      if (disposed) {
        unlistenResize();
        unlistenClose();
      } else {
        stopListening.push(unlistenResize, unlistenClose);
      }
    })();

    return () => {
      disposed = true;
      stopListening.forEach((stop) => stop());
    };
  }, [resolveWindow, syncMaximizedState]);

  const runWindowAction = useCallback(
    async (action: WindowAction) => {
      const appWindow = await resolveWindow();
      if (!appWindow) return;

      try {
        if (action === "close") {
          if (!confirmWindowClose()) return;
          await appWindow.destroy();
          return;
        }
        await appWindow[action]();
        if (action === "toggleMaximize") await syncMaximizedState();
      } catch (error) {
        console.warn(`Unable to ${action} the desktop window.`, error);
      }
    },
    [resolveWindow, syncMaximizedState],
  );

  const runtimeHint = isTauriRuntime ? "" : t("window.desktopOnly");
  const displayEdition = edition === undefined ? t("window.edition") : edition;
  const classes = ["window-titlebar", isMaximized && "is-maximized", className]
    .filter(Boolean)
    .join(" ");

  return (
    <header
      className={classes}
      data-tauri-drag-region=""
      data-runtime={isTauriRuntime ? "tauri" : "browser"}
      aria-label={t("window.titlebar")}
    >
      <div className="window-titlebar-identity" data-tauri-drag-region="" aria-label={title}>
        <span className="window-titlebar-appmark" aria-hidden="true"><BrandMark /></span>
        <span className="window-titlebar-title">{title}</span>
        {displayEdition && <span className="window-titlebar-edition">{displayEdition}</span>}
      </div>

      <div className="window-titlebar-drag-surface" data-tauri-drag-region="" aria-hidden="true" />

      <div className="window-titlebar-controls">
        <button
          type="button"
          className="window-titlebar-control"
          onClick={() => void runWindowAction("minimize")}
          aria-label={t("window.minimiseAria", { hint: runtimeHint })}
          aria-disabled={!isTauriRuntime}
          title={t("window.minimise")}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 8.5h8" />
          </svg>
        </button>

        <button
          type="button"
          className="window-titlebar-control"
          onClick={() => void runWindowAction("toggleMaximize")}
          aria-label={t("window.maximiseAria", { action: t(isMaximized ? "window.restore" : "window.maximise"), hint: runtimeHint })}
          aria-pressed={isMaximized}
          aria-disabled={!isTauriRuntime}
          title={t(isMaximized ? "window.restore" : "window.maximise")}
        >
          {isMaximized ? (
            <svg className="restore-glyph" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M4.25 3.25V2h5.75v5.75H8.75" />
              <rect x="2" y="4" width="5.75" height="5.75" />
            </svg>
          ) : (
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <rect x="2.25" y="2.25" width="7.5" height="7.5" />
            </svg>
          )}
        </button>

        <button
          type="button"
          className="window-titlebar-control window-titlebar-close"
          onClick={() => void runWindowAction("close")}
          aria-label={t("window.closeAria", { hint: runtimeHint })}
          aria-disabled={!isTauriRuntime}
          title={t("window.close")}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="m2.5 2.5 7 7m0-7-7 7" />
          </svg>
        </button>
      </div>
    </header>
  );
}
