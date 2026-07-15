# GitHub publishing checklist / GitHub 发布清单

## Recommended repository identity

- **Repository name:** `skills-manager-desktop`
- **English description:** `Local-first desktop manager for discovering, translating, auditing and deploying Agent Skills across Codex, Claude Code and Cursor. No telemetry.`
- **中文描述：** `本地优先的桌面 Agent Skills 管理器，支持 Codex、Claude Code 与 Cursor 的发现、翻译、安全审计和部署，无遥测。`
- **Topics:** `tauri`, `rust`, `react`, `typescript`, `sqlite`, `desktop-app`, `agent-skills`, `codex`, `claude-code`, `cursor`, `local-first`, `no-telemetry`

Alternative names: `agent-skills-manager` or `local-skills-manager`.

## Before making the repository public

1. Confirm that `LICENSE` identifies the MIT-licensed code and Victor Kuo as the copyright holder.
2. Keep the separate `BRAND_LICENSE.md` notice when publishing the Skills Manager identity assets.
3. Rotate any API key that has ever been pasted into chat, an issue or a screenshot.
4. Enable GitHub Secret Scanning, Dependabot alerts and Private Vulnerability Reporting.
5. Protect `main` and require the `CI / Verify Windows build` check before merging.

## Create and push the repository

With GitHub CLI installed and authenticated:

```powershell
git branch -M main
git add .
git commit -m "chore: prepare Skills Manager 1.0.0"
gh repo create skills-manager-desktop --public --source . --remote origin --push
```

Before committing, review `git status --short` and confirm that `release-assets/`, `src-tauri/target/`, `dist/`, `.artifacts/`, databases, logs and credentials are not staged.

## Publish downloadable installers

The repository workflow `.github/workflows/release-windows.yml` publishes a release whenever a matching SemVer tag is pushed. The three version declarations must match the tag.

```powershell
git tag -a v1.0.0 -m "Skills Manager 1.0.0"
git push origin v1.0.0
```

The workflow performs tests, creates clean NSIS and MSI packages, generates `SHA256SUMS.txt`, and uploads all three files to GitHub Releases. Re-running the same tag updates matching release assets; use a new version tag for any changed public binary.

## 中文发布步骤

推荐仓库名为 `skills-manager-desktop`。项目代码采用 MIT License，版权名为 Victor Kuo；品牌素材适用单独的品牌使用说明。公开前请轮换曾在对话或截图中出现的 API Key，并开启 Secret Scanning、Dependabot 与 Private Vulnerability Reporting。创建仓库后将默认分支改为 `main`；推送 `v1.0.0` 标签即可触发 Windows MSI/NSIS 自动构建和 GitHub Releases 下载发布。
