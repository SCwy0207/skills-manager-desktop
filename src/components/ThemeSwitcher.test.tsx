import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ThemeSwitcher } from "./ThemeSwitcher";

describe("ThemeSwitcher", () => {
  it("renders an accessible three-mode control", () => {
    const html = renderToStaticMarkup(<ThemeSwitcher />);

    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Follow system"');
    expect(html).toContain('aria-label="Dark theme"');
    expect(html).toContain('aria-label="Light theme"');
    expect(html.match(/aria-pressed=/g)).toHaveLength(3);
  });

  it("supports the icon-only compact presentation without losing labels", () => {
    const html = renderToStaticMarkup(<ThemeSwitcher compact />);

    expect(html).toContain("is-compact");
    expect(html).toContain("Follow system");
    expect(html).toContain("Dark theme");
    expect(html).toContain("Light theme");
  });
});
