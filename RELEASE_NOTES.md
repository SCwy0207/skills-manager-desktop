# Skills Manager v1.0.1

Skills Manager 1.0.1 expands the local-first desktop workspace from Codex-only session discovery to a unified Codex, Claude Code and Cursor session experience, and introduces evidence-driven Custom Skills generation.

## Highlights

- Indexes local Codex, Claude Code and Cursor sessions on startup, on window focus and when the session list reaches its end.
- Uses each Agent's native session title when available and filters internal/sub-agent traces instead of exposing duplicate “Untitled session” rows.
- Organises sessions as `Agent → project/workspace → session`, using registered project names and hiding Agent groups that have no detected sessions.
- Adds safe right-click, `F2` and `Shift+F10` session renaming. Names are written back to the native Codex, Claude Code or Cursor store so the Agent shows the same title next time it opens.
- Adds the Custom Skills workbench: required follow-up questions, optional Session evidence, optional constrained OpenAPI search, editable file preview and validation before save.
- Treats selected Session evidence as the primary business source and checks generated Skills for missing requirements, conflicts and unsupported expansion.
- Adds custom Skill scanning, safe staged writes, Agent link repair and Codex/Claude global guidance integration.
- Fixes Custom Skills and session surfaces so all controls, lists, menus and dialogs follow Future Light and Future Dark themes.

## Safety and privacy

- Remote Session context remains disabled by default and is only sent when the user explicitly enables it.
- OpenAPI search is restricted to configured HTTPS operations and blocks redirects, private network targets and external `$ref` values.
- Generated scripts are never executed. Blocking security findings cannot be overridden.
- Audit records store hashes, counts and outcomes rather than raw sessions, prompts, search content or API keys.

## Validation

- Frontend tests and TypeScript production build.
- Rust unit and integration tests covering native session parsing/renaming, OpenAPI restrictions, evidence validation, custom Skill persistence and Agent repair.
- Windows MSI and NSIS packaging through the repository release workflow.

## Downloads

- Use `Skills-Manager_1.0.1_windows-x64-setup.exe` for a normal per-user installation.
- Use `Skills-Manager_1.0.1_windows-x64_en-US.msi` for managed Windows environments.
- Verify either installer with `SHA256SUMS.txt`.

The Windows packages include the offline WebView2 runtime and are therefore intentionally large. They are not yet Authenticode-signed, so Windows may display an unknown-publisher warning.

---

# Skills Manager v1.0.1 中文说明

Skills Manager 1.0.1 将本地会话能力从 Codex 扩展为 Codex、Claude Code、Cursor 统一体验，并加入以会话证据为核心的自定义 Skills 生成工作台。

## 主要更新

- 启动、窗口重新获得焦点以及会话列表滚动到底部时，自动刷新三类 Agent 的本地会话。
- 优先显示 Agent 原生会话名称，过滤内部/子 Agent 轨迹，避免重复的“未命名会话”。
- 使用“Agent → 项目/工作区 → 会话”目录树；已登记项目显示项目名称，没有检测到会话的 Agent 不显示一级标题。
- 支持右键、`F2` 和 `Shift+F10` 重命名，并将名称安全写回 Codex、Claude Code 或 Cursor 原生存储，使 Agent 下次打开时显示相同名称。
- 新增自定义 Skills 工作台：必答追问、可选 Session 证据、受限 OpenAPI 联网搜索、文件预览编辑和保存前验证。
- 勾选 Session 时，以会话业务证据为最高优先级；生成后检查需求缺失、证据冲突和无依据扩展。
- 新增自定义 Skill 扫描、安全暂存写入、Agent 链接修复，以及 Codex/Claude 全局引导接入。
- 修复浅色主题中的黑色列表和控件，目录树、菜单、弹窗与表单均跟随 Future Light / Future Dark。

远程 Session 上下文默认关闭；联网搜索仅允许配置好的 HTTPS 操作并阻断重定向、内网地址和外部 `$ref`。生成脚本永不执行，阻断级安全风险不可绕过。普通用户建议下载 NSIS `setup.exe`，受管环境可使用 MSI；安装前请使用 `SHA256SUMS.txt` 校验。
