// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PaneResizeHandle } from "./PaneResizeHandle";

const storageKey = "test:list-pane-width";
let host: HTMLDivElement;
let root: Root;

function setHostWidth(width: number) {
  Object.defineProperty(host, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      width,
      height: 600,
      top: 0,
      right: width,
      bottom: 600,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => undefined,
    }),
  });
}

function dispatchKeyboard(target: Element, key: string, shiftKey = false) {
  target.dispatchEvent(new KeyboardEvent("keydown", {
    key,
    shiftKey,
    bubbles: true,
    cancelable: true,
  }));
}

function dispatchPointer(target: Element, type: string, clientX: number, pointerId = 1) {
  const event = new MouseEvent(type, {
    button: 0,
    clientX,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  target.dispatchEvent(event);
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  host = document.createElement("div");
  setHostWidth(1000);
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  // React exposes this flag for test environments but does not type it globally.
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = false;
});

describe("PaneResizeHandle", () => {
  it("publishes the persisted width and accessible separator values", () => {
    window.localStorage.setItem(storageKey, "500");

    act(() => {
      root.render(<PaneResizeHandle storageKey={storageKey} />);
    });

    const separator = host.querySelector<HTMLElement>("[role=separator]");
    expect(separator).not.toBeNull();
    expect(separator?.getAttribute("aria-orientation")).toBe("vertical");
    expect(separator?.getAttribute("aria-valuenow")).toBe("500");
    expect(host.style.getPropertyValue("--list-pane-width")).toBe("500px");
  });

  it("supports fine, accelerated, boundary, and reset keyboard actions", () => {
    act(() => {
      root.render(
        <PaneResizeHandle
          storageKey={storageKey}
          defaultWidth={400}
          minWidth={280}
          detailMinWidth={420}
          step={8}
          largeStep={40}
        />,
      );
    });

    const separator = host.querySelector<HTMLElement>("[role=separator]")!;

    act(() => dispatchKeyboard(separator, "ArrowRight"));
    expect(separator.getAttribute("aria-valuenow")).toBe("408");

    act(() => dispatchKeyboard(separator, "ArrowLeft", true));
    expect(separator.getAttribute("aria-valuenow")).toBe("368");

    act(() => dispatchKeyboard(separator, "End"));
    expect(separator.getAttribute("aria-valuenow")).toBe("571");

    act(() => dispatchKeyboard(separator, "Home"));
    expect(separator.getAttribute("aria-valuenow")).toBe("280");

    act(() => separator.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(separator.getAttribute("aria-valuenow")).toBe("400");
    expect(window.localStorage.getItem(storageKey)).toBe("400");
  });

  it("captures the pointer while dragging and persists the final width", () => {
    act(() => {
      root.render(<PaneResizeHandle storageKey={storageKey} defaultWidth={400} />);
    });

    const separator = host.querySelector<HTMLElement>("[role=separator]")!;
    let capturedPointer: number | null = null;
    separator.setPointerCapture = (pointerId) => { capturedPointer = pointerId; };
    separator.hasPointerCapture = (pointerId) => capturedPointer === pointerId;
    separator.releasePointerCapture = () => { capturedPointer = null; };

    act(() => dispatchPointer(separator, "pointerdown", 300));
    expect(capturedPointer).toBe(1);
    expect(separator.getAttribute("data-dragging")).toBe("true");

    act(() => dispatchPointer(separator, "pointermove", 355));
    expect(separator.getAttribute("aria-valuenow")).toBe("455");

    act(() => dispatchPointer(separator, "pointerup", 355));
    expect(capturedPointer).toBeNull();
    expect(separator.hasAttribute("data-dragging")).toBe(false);
    expect(window.localStorage.getItem(storageKey)).toBe("455");
  });
});
