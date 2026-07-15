# Skills Manager v1.0.0

Skills Manager 1.0.0 is the first public release of the local-first desktop workspace for Codex sessions and Agent Skills.

## v1.0.0 hotfix refresh

- Fixed the custom title-bar close button so the window and process exit normally.
- Enforced a single running application instance; launching Skills Manager again now restores and focuses the existing window.
- Fixed DeepSeek V4 translation and summary generation. The official DeepSeek endpoint now uses supported JSON mode, starts with a fast non-thinking request, and retries once with a larger thinking budget when the first result cannot be loaded.
- Reasoning text is never displayed or stored as a Skill description; only the validated final response is accepted.

## What is included

- Search local Codex sessions with Chinese/English substring matching and highlights.
- Discover and manage Skills across Codex, Claude Code and Cursor.
- Inspect Skill health and run local static security scans without executing Skill content.
- Deploy managed Skills from one content-addressed source to multiple agents.
- Translate or summarise English Skill descriptions into a local Chinese overlay.
- Use Ollama/LM Studio, OpenAI BYOK or a generic OpenAI-compatible HTTPS endpoint.
- Select exactly which Skills to translate, retry failed items and regenerate existing results.
- Switch between English (UK), Simplified Chinese and Traditional Chinese, plus Future Dark and Future Light themes.

## Downloads

- Use the NSIS `setup.exe` for a normal per-user Windows installation.
- Use the MSI package for managed Windows environments.
- Compare your download with `SHA256SUMS.txt` before installation.

The packages include the offline WebView2 runtime and are therefore approximately 201 MiB each. This release is not yet Authenticode-signed, so Windows may display an unknown-publisher warning.

The source code and technical documentation are available under the MIT
License, copyright © 2026 Victor Kuo. Product identity assets are covered by
the repository's separate brand-use notice.

---

# Skills Manager v1.0.0 中文说明

这是 Skills Manager 的首个公开版本：本地检索 Codex 会话，统一发现、审计、翻译和部署 Codex、Claude Code 与 Cursor Skills。应用无遥测，普通扫描不会触发模型请求；远程 AI 仅在用户主动确认后发送列明字段。源代码与技术文档采用 MIT License，版权名为 Victor Kuo；产品品牌素材适用仓库中的单独品牌使用说明。

本次 v1.0.0 热修复解决了标题栏关闭按钮失效和应用多开问题；重复启动现在只会恢复并聚焦已有窗口。同时修复 DeepSeek V4 中文翻译：优先使用快速非思考模式，结果无法加载时自动使用更大输出预算进行一次思考模式兜底，并且只保存通过校验的最终中文正文，不展示或存储思考内容。

普通用户建议下载 NSIS `setup.exe`，受管环境可使用 MSI。安装包携带 WebView2 离线运行时，体积约 201 MiB；安装前请使用 `SHA256SUMS.txt` 校验。当前版本暂未进行 Authenticode 签名，Windows 可能显示未知发布者提示。
