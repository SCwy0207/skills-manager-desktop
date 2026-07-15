import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HighlightText } from "./Common";

describe("HighlightText", () => {
  it("高亮中文子串", () => {
    const html = renderToStaticMarkup(
      <HighlightText text="实现中英文会话全文搜索" query="会话" />,
    );

    expect(html).toContain("<mark>会话</mark>");
    expect(html).toContain("实现中英文");
  });

  it("英文匹配忽略大小写并保留原始文本", () => {
    const html = renderToStaticMarkup(
      <HighlightText text="Skills Manager" query="manager" />,
    );

    expect(html).toContain("<mark>Manager</mark>");
  });

  it("空查询不生成高亮标签", () => {
    const html = renderToStaticMarkup(
      <HighlightText text="Local Skill" query="  " />,
    );

    expect(html).toBe("Local Skill");
  });
});
