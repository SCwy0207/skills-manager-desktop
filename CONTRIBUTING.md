# Contributing to Skills Manager

Thank you for helping improve Skills Manager. English is preferred for issues and pull requests; a Chinese summary is welcome.

Unless explicitly agreed otherwise, contributions submitted for inclusion in
the project are licensed under the repository's MIT License. The separate
brand-use notice does not grant contributors or forks rights to present a
modified distribution as the official Skills Manager product.

## Branch and commit conventions

The repository follows a lightweight Git Flow model:

- `main` contains reviewed, releasable code and release tags.
- `develop` is the integration branch for the next release.
- Use `feature/<short-name>`, `fix/<short-name>`, `release/<version>` and
  `hotfix/<short-name>` for focused work.

Commit messages follow Conventional Commits:

```text
<type>(optional-scope): <imperative summary>
```

Common types are `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`,
`perf` and `chore`. Keep the first line concise; use the body to explain why,
behavioural trade-offs and migration impact. Mark breaking changes with `!`
or a `BREAKING CHANGE:` footer.

Examples:

```text
feat(skills): add selective translation retry
fix(provider): preserve an existing v1 endpoint
docs: clarify local-first privacy boundaries
```

## Development setup

1. Install Node.js 24, pnpm 11.7.0 and stable Rust with `rustfmt` and `clippy`.
2. Install the Tauri prerequisites for your operating system.
3. Run `pnpm install --frozen-lockfile`.
4. Start the desktop app with `pnpm tauri dev`, or the mock browser UI with `pnpm dev`.

## Before opening a pull request

Run:

```powershell
pnpm test
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

Keep changes within the existing presentation, business, data-access and infrastructure boundaries. Database changes require a new forward-only migration; never edit a migration that may already have shipped.

When changing user-facing text, update English (UK), Simplified Chinese and Traditional Chinese catalogues together. UI pull requests should include screenshots for both themes. Any change that adds network access, sends data to an AI provider, changes credential handling or expands filesystem/process access must document its privacy and security impact.

Do not commit generated build directories, installers, databases, logs, credentials, real session text, usernames or absolute machine paths. Test credentials must be unmistakably synthetic.

## Pull request checklist

- The change is focused and explained.
- Tests cover new behaviour and all checks pass.
- Three-language UI strings stay in sync.
- Database migrations remain backward compatible.
- Privacy, security and network effects are documented.
- No secret, personal path or generated binary is included.

## 中文说明

Issue 与 Pull Request 以英文为主，可附中文摘要。分支采用轻量 Git Flow：`main` 只保存可发布版本，`develop` 用于下一版本集成，功能和修复分别使用 `feature/*`、`fix/*`，提交信息遵循 Conventional Commits。除非另有明确协议，提交并被项目接受的贡献将按 MIT License 授权；品牌使用说明不允许修改版冒充官方 Skills Manager。提交前请运行全部前端与 Rust 检查；新增数据库字段必须通过新的只向前迁移实现。界面文案需同步 English (UK)、简体中文和繁體中文；UI 修改请提供明暗主题截图。涉及网络、AI Provider、凭据、文件系统或进程权限的变更必须说明隐私与安全影响。禁止提交安装包、构建目录、数据库、日志、真实凭据、会话内容、用户名或本机绝对路径。
