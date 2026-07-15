import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import { useI18n } from "../i18n/i18n";
import "./PaneResizeHandle.css";

const FALLBACK_HANDLE_WIDTH = 9;

interface PaneBounds {
  min: number;
  max: number;
}

interface DragState {
  pointerId: number;
  startX: number;
  startWidth: number;
}

export interface PaneResizeHandleProps {
  /** A unique key allows each workspace to remember its own list width. */
  storageKey?: string;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  /** Minimum usable width reserved for the detail pane. */
  detailMinWidth?: number;
  step?: number;
  largeStep?: number;
  label?: string;
  controls?: string;
  className?: string;
  onWidthChange?: (width: number) => void;
}

function clamp(value: number, bounds: PaneBounds) {
  return Math.min(bounds.max, Math.max(bounds.min, value));
}

function readStoredWidth(storageKey: string, fallback: number) {
  if (typeof window === "undefined") return fallback;

  try {
    const value = Number.parseFloat(window.localStorage.getItem(storageKey) ?? "");
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

function storeWidth(storageKey: string, width: number) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(storageKey, String(Math.round(width)));
  } catch {
    // Persistence is a convenience; resizing must still work in a restricted WebView.
  }
}

export function PaneResizeHandle({
  storageKey = "skills-manager:list-pane-width",
  defaultWidth = 414,
  minWidth = 280,
  maxWidth = 720,
  detailMinWidth = 420,
  step = 8,
  largeStep = 40,
  label,
  controls,
  className = "",
  onWidthChange,
}: PaneResizeHandleProps) {
  const { t } = useI18n();
  const accessibleLabel = label ?? t("common.resize.label");
  const initialWidth = readStoredWidth(storageKey, defaultWidth);
  const handleRef = useRef<HTMLDivElement>(null);
  const preferredWidthRef = useRef(initialWidth);
  const widthRef = useRef(initialWidth);
  const dragRef = useRef<DragState | null>(null);
  const [width, setWidth] = useState(initialWidth);
  const [bounds, setBounds] = useState<PaneBounds>({
    min: Math.min(minWidth, maxWidth),
    max: Math.max(minWidth, maxWidth),
  });
  const [isDragging, setIsDragging] = useState(false);

  const measureBounds = useCallback((): PaneBounds => {
    const handle = handleRef.current;
    const parent = handle?.parentElement;
    const parentWidth = parent?.getBoundingClientRect().width ?? 0;

    if (!handle || !parent || parentWidth <= 0) {
      return {
        min: Math.min(minWidth, maxWidth),
        max: Math.max(minWidth, maxWidth),
      };
    }

    const measuredHandleWidth = handle.getBoundingClientRect().width;
    const handleWidth = measuredHandleWidth > 0
      ? measuredHandleWidth
      : FALLBACK_HANDLE_WIDTH;
    const availableForList = Math.max(0, parentWidth - detailMinWidth - handleWidth);
    const effectiveMax = Math.min(maxWidth, availableForList);

    // If the window is narrower than both pane minimums, the detail pane wins.
    // Normal desktop sizes retain minWidth for the list as well.
    return {
      min: Math.min(minWidth, effectiveMax),
      max: effectiveMax,
    };
  }, [detailMinWidth, maxWidth, minWidth]);

  const renderWidth = useCallback((nextWidth: number, nextBounds = measureBounds()) => {
    const next = clamp(nextWidth, nextBounds);
    const parent = handleRef.current?.parentElement;

    widthRef.current = next;
    setWidth(next);
    setBounds(nextBounds);
    parent?.style.setProperty("--list-pane-width", `${next}px`);
    onWidthChange?.(next);
    return next;
  }, [measureBounds, onWidthChange]);

  const chooseWidth = useCallback((nextWidth: number, persist = true) => {
    const next = renderWidth(nextWidth);
    preferredWidthRef.current = next;
    if (persist) storeWidth(storageKey, next);
    return next;
  }, [renderWidth, storageKey]);

  const resetWidth = useCallback(() => {
    chooseWidth(defaultWidth);
  }, [chooseWidth, defaultWidth]);

  useEffect(() => {
    const handle = handleRef.current;
    const parent = handle?.parentElement;
    if (!handle || !parent) return;

    const syncToParent = () => {
      const nextBounds = measureBounds();
      renderWidth(preferredWidthRef.current, nextBounds);
    };

    syncToParent();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(syncToParent);
      observer.observe(parent);
      return () => {
        observer.disconnect();
        parent.style.removeProperty("--list-pane-width");
      };
    }

    window.addEventListener("resize", syncToParent);
    return () => {
      window.removeEventListener("resize", syncToParent);
      parent.style.removeProperty("--list-pane-width");
    };
  }, [measureBounds, renderWidth]);

  const finishDrag = useCallback((pointerId: number) => {
    if (dragRef.current?.pointerId !== pointerId) return;

    dragRef.current = null;
    preferredWidthRef.current = widthRef.current;
    storeWidth(storageKey, widthRef.current);
    setIsDragging(false);
  }, [storageKey]);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || dragRef.current) return;

    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: widthRef.current,
    };
    setIsDragging(true);
    event.preventDefault();

    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    chooseWidth(drag.startWidth + event.clientX - drag.startX, false);
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    finishDrag(event.pointerId);

    if (
      typeof event.currentTarget.hasPointerCapture === "function"
      && event.currentTarget.hasPointerCapture(event.pointerId)
      && typeof event.currentTarget.releasePointerCapture === "function"
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const increment = event.shiftKey ? largeStep : step;

    switch (event.key) {
      case "ArrowLeft":
        chooseWidth(widthRef.current - increment);
        break;
      case "ArrowRight":
        chooseWidth(widthRef.current + increment);
        break;
      case "Home":
        chooseWidth(measureBounds().min);
        break;
      case "End":
        chooseWidth(measureBounds().max);
        break;
      default:
        return;
    }

    event.preventDefault();
  };

  return (
    <div
      ref={handleRef}
      className={`pane-resize-handle${className ? ` ${className}` : ""}`}
      role="separator"
      aria-label={accessibleLabel}
      aria-orientation="vertical"
      aria-valuemin={Math.round(bounds.min)}
      aria-valuemax={Math.round(bounds.max)}
      aria-valuenow={Math.round(width)}
      aria-valuetext={t("common.resize.value", { width: Math.round(width) })}
      aria-controls={controls}
      tabIndex={0}
      data-dragging={isDragging || undefined}
      title={t("common.resize.hint")}
      onDoubleClick={resetWidth}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onLostPointerCapture={(event) => finishDrag(event.pointerId)}
    >
      <span className="pane-resize-handle-grip" aria-hidden="true" />
    </div>
  );
}
