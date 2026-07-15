# Skills Manager

[English](README.md) | [简体中文](README.zh-CN.md)

**本地优先的桌面 Agent Skills 管理器：统一发现、翻译、安全审计和部署 Codex、Claude Code 与 Cursor Skills；无遥测。**

![Skills Manager 品牌字标](assets/brand/skills-manager-lockup-light.png)

Skills Manager 将 Codex、Claude Code、Cursor 本地会话检索和多 Agent Skills 管理整合进一个原生桌面工作区。应用基于 Tauri、Rust 与 React 构建，索引和操作数据保存在本机；扫描、预览和静态审计不会执行 Skill 内容。

> 项目状态：`v1.0.1` 新增多 Agent 原生会话标题、项目目录树、安全原生重命名与自定义 Skills 工作台。当前提供 Windows 安装包；macOS 与 Linux 可从源码构建，但暂未提供官方二进制下载。

## 下载

[**下载最新 Windows 版本**](../../releases/latest)

每个 GitHub Release 包含：

- `Skills-Manager_<version>_windows-x64-setup.exe`：适合大多数用户的 NSIS 安装器。
- `Skills-Manager_<version>_windows-x64_en-US.msi`：适合受管 Windows 环境的 MSI 包。
- `SHA256SUMS.txt`：两个安装包的 SHA-256 校验值。

PowerShell 校验示例：

```powershell
Get-FileHash .\Skills-Manager_1.0.1_windows-x64-setup.exe -Algorithm SHA256
```

Windows 安装包携带 WebView2 离线运行时，因此体积较大，安装时无需再下载该组件。首个公开版本暂未进行 Authenticode 代码签名，Windows SmartScreen 可能显示“未知发布者”；请仅从本仓库的 Releases 页面下载。

## 主要能力

- 增量索引 Codex、Claude Code、Cursor 本地会话，保留原生标题，并按 Agent 与项目/工作区组织目录树。
- 发现 Codex、Claude Code、Cursor 的用户级与项目级 Skills，并显示重复名称、断链、托管位置和只读来源。
- 将本地 Skill 导入内容寻址中央库，通过经验证的 junction 或符号链接部署到多个 Agent。
- 执行纯本地静态风险扫描，展示脱敏证据；发现、预览和扫描都不会执行脚本。
- 生成“忠实翻译”或 40–80 字中文能力总结，仅写入本地覆盖层，不覆盖作者原始 `SKILL.md` 和 description。
- 支持回环地址上的 Ollama / LM Studio、OpenAI BYOK 和用户配置的 HTTPS OpenAI-compatible API。
- 批量翻译可选择缺失、过期、失败或已经翻译的 Skills，支持按选择重试；重新打开时清除上一次运行日志。
- 新增“自定义 Skills”工作台：简短需求会经过必答追问、可选会话证据、受限 OpenAPI 搜索、静态扫描和语义校验，完成审阅后才允许保存。
- 内置 Future Dark / Future Light 双主题、紧凑/舒适密度、命令中心与永久状态栏。
- 全局界面语言支持 English (UK，默认)、简体中文和繁體中文。
- 无遥测、无后台上传；普通 Skill 扫描不会触发模型请求。

## 默认 Skills 位置

| Agent | 用户级 | 项目级 |
| --- | --- | --- |
| Codex | `~/.agents/skills` | `<project>/.agents/skills` |
| Claude Code | `~/.claude/skills` | `<project>/.claude/skills` |
| Cursor | `~/.cursor/skills` | `<project>/.cursor/skills` |

项目目录采用显式信任模型。未信任项目可建立只读库存，但不能部署、启停或编辑 Skill。

## AI 中文简介与隐私

AI 中文简介默认关闭，仅在用户主动操作后生成。

- 本地 Provider 仅允许字面量回环主机 `127.0.0.1` 或 `[::1]`，拒绝重定向、URL 用户信息、查询参数、片段和局域网地址。
- OpenAI 使用官方端点并设置 `store: false`；凭据只写入系统凭据库，不进入 SQLite、浏览器存储或日志。
- 通用 API 使用用户配置的 HTTPS Base URL、模型和独立凭据；已有 `/v1` 路径保持不变，裸域名补全 `/chat/completions`。
- 远程翻译通常只发送 Skill 名称和作者 description。正文片段只允许单条额外确认；批量任务遇到缺失 description 时跳过。
- API Key、私钥、Bearer Token、连接串、绝对路径等敏感输入会在远程请求前被拦截。

完整边界见 [PRIVACY.md](PRIVACY.md)。

## 自定义 Skills 的隐私与安全

自定义 Skills 通过原子写入保存到安装目录下的 `custome skills\<skill-name>`，并和其他 Skill 一起被扫描；应用绝不执行生成出的脚本。

- 选择会话后，系统在本地保存会话 ID、哈希、证据片段和需求台账。会话业务事实在生成与校验中始终优先于用户需求和联网候选。
- 远程 Provider 只有在设置中启用“允许远程 Session 上下文”后，才会收到脱敏且必要的会话上下文；该开关默认关闭。审计不写入 Prompt、会话原文、搜索原文或 API Key。
- 可选 OpenAPI 搜索仅接受用户导入的 OpenAPI 3.x JSON 和 HTTPS GET/POST 操作；拒绝重定向、URL 凭据、回环/私有字面量主机、服务器变量、callbacks 与 `$ref`。搜索 API Key 仅保存于系统凭据库。
- 联网候选会展示来源和许可证，并被当作不可信数据：仅可参考方法或结构，不能覆盖会话事实，也不能复制未授权内容。
- 校验警告必须填写覆盖理由；阻断级安全风险永远不能覆盖。

## 技术栈

- Tauri 2 + Rust
- React 19 + TypeScript + Tailwind CSS
- SQLite / FTS5（`trigram` tokenizer）
- Zustand + TanStack Query

## 本地开发

需要 Node.js 24、pnpm 11.7.0、稳定版 Rust（含 `rustfmt` 与 `clippy`），以及对应平台的 [Tauri 系统依赖](https://v2.tauri.app/start/prerequisites/)。

```powershell
pnpm install --frozen-lockfile
pnpm tauri dev
```

仅运行浏览器演示：

```powershell
pnpm dev
```

测试与构建：

```powershell
pnpm test
pnpm build
cargo test --locked --manifest-path src-tauri/Cargo.toml
pnpm tauri build --ci --bundles nsis,msi -- --locked
```

## 自动发布

`package.json`、`src-tauri/Cargo.toml` 和 `src-tauri/tauri.conf.json` 的版本必须一致。推送 `v1.0.1` 这类 SemVer Tag 后，GitHub Actions 会执行干净构建，只接受一份 NSIS 和一份 MSI，生成 SHA-256 校验文件并发布到 GitHub Releases。

```powershell
git tag v1.0.1
git push origin v1.0.1
```

## 贡献、安全与许可

提交代码前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全漏洞请按 [SECURITY.md](SECURITY.md) 私下报告，不要创建公开 Issue。

程序源代码与技术文档采用 [MIT License](LICENSE)，版权归 Victor Kuo 所有，Copyright © 2026。Skills Manager 名称、Skill Relay Logo、应用图标和安装器视觉素材适用单独的[品牌使用说明](BRAND_LICENSE.md)；修改版发行应使用不同的产品名称与视觉标识。

## 商标说明

Skills Manager 是独立社区项目。Codex 与 OpenAI 是 OpenAI 的商标，Claude 是 Anthropic 的商标，Cursor 是 Anysphere 的商标。本项目未获得上述公司的背书、赞助，也不与其存在隶属关系。
