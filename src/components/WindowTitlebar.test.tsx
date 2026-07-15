/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriWindow = vi.hoisted(() => ({
  destroy: vi.fn(async () => undefined),
  minimize: vi.fn(async () => undefined),
  toggleMaximize: vi.fn(async () => undefined),
  isMaximized: vi.fn(async () => false),
  onResized: vi.fn(async () => () => undefined),
  onCloseRequested: vi.fn(async () => () => undefined),
}));

vi.mock("../lib/ipc", () => ({ isTauriRuntime: true }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => tauriWindow }));

import { useUiStore } from "../store/ui";
import { WindowTitlebar } from "./WindowTitlebar";

describe("WindowTitlebar", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.clearAllMocks();
    useUiStore.setState({ skillEditorDirty: false, criticalOperations: {} });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<WindowTitlebar />);
      await Promise.resolve();
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("destroys the desktop window when the custom close button is pressed", async () => {
    const closeButton = container.querySelector<HTMLButtonElement>(".window-titlebar-close");
    expect(closeButton).not.toBeNull();

    await act(async () => {
      closeButton?.click();
      await Promise.resolve();
    });

    expect(tauriWindow.destroy).toHaveBeenCalledTimes(1);
  });

  it("keeps the window open when discarding unsaved changes is cancelled", async () => {
    useUiStore.setState({ skillEditorDirty: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const closeButton = container.querySelector<HTMLButtonElement>(".window-titlebar-close");

    await act(async () => {
      closeButton?.click();
      await Promise.resolve();
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(tauriWindow.destroy).not.toHaveBeenCalled();
  });
});
