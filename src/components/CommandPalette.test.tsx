import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CommandPalette } from "./CommandPalette";

describe("CommandPalette", () => {
  it("renders desktop navigation and theme commands with accessible semantics", () => {
    const html = renderToStaticMarkup(
      <CommandPalette open onOpenChange={vi.fn()} />,
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain("Sessions");
    expect(html).toContain("Skills");
    expect(html).toContain("Theme: Future Dark");
    expect(html).toContain("Theme: Future Light");
    expect(html).toContain("Generate Chinese description for current skill");
    expect(html).toContain("Generate Chinese descriptions in bulk");
    expect(html.match(/role="option"/g)).toHaveLength(12);
  });

  it("does not leave an inactive modal in the document", () => {
    const html = renderToStaticMarkup(
      <CommandPalette open={false} onOpenChange={vi.fn()} />,
    );

    expect(html).toBe("");
  });
});
