# Privacy

[English](#english) | [简体中文](#简体中文)

## English

Skills Manager is local-first and contains no telemetry or advertising SDK. Ordinary application startup, Codex session indexing and Skill discovery do not make model requests.

### Data stored locally

The application may store the following in its operating-system application-data directory:

- a SQLite index of discovered sessions and Skills;
- locally generated or manually edited Chinese description overlays;
- managed Skill metadata and content-addressed copies;
- user preferences and redacted operational audit entries.

Remote API credentials are not written to this database, browser storage or application logs. They are stored in the operating system credential store. If that facility is unavailable, OpenAI may read `OPENAI_API_KEY` from the process environment without copying it to a file.

### Optional AI providers

AI descriptions are disabled by default. When a user explicitly starts a generation task:

- a local provider receives the selected Skill input over a loopback connection;
- OpenAI receives only the fields shown in the confirmation screen and requests use `store: false`;
- a generic OpenAI-compatible provider receives the confirmed fields at the user-configured HTTPS endpoint, subject to that provider's own data policy.

Translation normally sends a Skill name and author description. A body excerpt is never sent remotely in bulk and requires a separate confirmation for an individual Skill whose description is missing. Absolute paths, project names, scripts, references, environment variables, sessions and logs are not intentionally sent.

### Logs and deletion

Audit records contain operational metadata such as provider, model, mode, duration, character count, token count and outcome. They do not contain API keys, prompts, source Skill text or generated descriptions.

Uninstalling the application may not remove its application-data directory or credentials automatically. Users can clear generated descriptions in the application, remove provider credentials in Settings, and delete the application-data directory after closing the app.

## 简体中文

Skills Manager 采用本地优先设计，不包含遥测或广告 SDK。普通启动、Codex 会话索引和 Skill 发现不会产生模型请求。

应用可能在操作系统应用数据目录中保存 SQLite 索引、中文简介覆盖层、托管 Skill 元数据和内容寻址副本、用户偏好及脱敏审计记录。远程 API 凭据不会写入数据库、浏览器存储或日志，只保存在系统凭据库；系统凭据库不可用时，OpenAI 仅可只读使用进程环境中的 `OPENAI_API_KEY`。

AI 中文简介默认关闭。用户主动生成后，本机模型只通过回环地址接收输入；OpenAI 或通用 OpenAI-compatible Provider 只接收确认页列出的字段，并受对应 Provider 的数据政策约束。批量任务不会远程发送正文；单条 Skill 缺少 description 时必须再次确认。应用不会主动发送绝对路径、项目名、脚本、references、环境变量、会话或日志。

审计记录只包含 Provider、模型、模式、耗时、字符数、Token 数和结果等操作元数据，不记录 API Key、Prompt、原文或生成文本。用户可在应用内清除中文结果和 Provider 凭据；卸载后如需彻底清理，可在关闭应用后手动删除其应用数据目录。
