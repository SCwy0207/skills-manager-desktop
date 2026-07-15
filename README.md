# Skills Manager

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/SCwy0207/skills-manager-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/SCwy0207/skills-manager-desktop/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/SCwy0207/skills-manager-desktop?display_name=tag&sort=semver)](https://github.com/SCwy0207/skills-manager-desktop/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-5368ED.svg)](LICENSE)

**A local-first desktop manager for discovering, translating, auditing and deploying Agent Skills across Codex, Claude Code and Cursor. No telemetry.**

![Skills Manager brand lock-up](assets/brand/skills-manager-lockup-light.png)

Skills Manager brings local Codex session search and multi-agent Skill management into one native desktop workspace. It is built with Tauri, Rust and React, keeps its index and operational data on your device, and does not execute Skill content while scanning or previewing it.

> Project status: `v1.0.0` is the first public release. Windows installers are available; macOS and Linux can currently be built from source but do not yet have official release binaries.

## Download

[**Download the latest Windows release**](../../releases/latest)

Each GitHub Release contains:

- `Skills-Manager_<version>_windows-x64-setup.exe` — recommended NSIS installer for most users.
- `Skills-Manager_<version>_windows-x64_en-US.msi` — MSI package for managed Windows environments.
- `SHA256SUMS.txt` — SHA-256 checksums for both installers.

Verify a downloaded file in PowerShell:

```powershell
Get-FileHash .\Skills-Manager_1.0.0_windows-x64-setup.exe -Algorithm SHA256
```

The current Windows packages include the offline WebView2 runtime, so they are intentionally large and do not need to download that component during installation. The initial public packages are not yet Authenticode-signed; Windows SmartScreen may therefore show an unknown-publisher warning. Only download releases from this repository.

## Highlights

- **Codex session search** — incrementally indexes local JSONL sessions in SQLite and provides Chinese/English title and body substring search with UTF-16 highlight ranges.
- **One Skill inventory** — discovers user-level and project-level Skills for Codex, Claude Code and Cursor, including duplicate names, broken links, managed locations and read-only sources.
- **Single source, multiple agents** — imports a local Skill into a content-addressed store and deploys it through verified junctions or symbolic links.
- **Safe local inspection** — performs static risk scanning with redacted evidence and never executes Skill scripts during discovery, preview or scanning.
- **Chinese description overlay** — creates faithful translations or 40–80 character capability summaries without overwriting the author's `SKILL.md` or original description.
- **Provider choice** — supports loopback Ollama/LM Studio, OpenAI BYOK and user-configured HTTPS OpenAI-compatible chat-completions endpoints.
- **Explicit batch workflow** — lets users choose missing, stale, failed or already translated Skills, retry selected items, and clear previous run logs when reopening the workflow.
- **Desktop-native workspace** — includes Future Dark/Future Light themes, compact and comfortable density modes, a command centre and a persistent status bar.
- **Three interface languages** — English (UK, default), Simplified Chinese and Traditional Chinese.
- **Local-first privacy** — no telemetry, no background uploads and no model request during ordinary Skill scans.

## Supported locations

| Agent | User-level Skills | Project-level Skills |
| --- | --- | --- |
| Codex | `~/.agents/skills` | `<project>/.agents/skills` |
| Claude Code | `~/.claude/skills` | `<project>/.claude/skills` |
| Cursor | `~/.cursor/skills` | `<project>/.cursor/skills` |

Project directories use an explicit trust model. An untrusted project may be inventoried read-only, but Skills Manager will not deploy, enable, disable or edit its Skills.

## AI description privacy

AI descriptions are disabled by default and are only generated after an explicit user action.

- Local providers are restricted to literal loopback hosts (`127.0.0.1` or `[::1]`). Redirects, user information, query strings, fragments and LAN addresses are rejected.
- OpenAI uses its official endpoint with `store: false`. Credentials are written to the operating system credential store and are never stored in SQLite, local storage or logs.
- A generic API provider uses the configured HTTPS base URL, model and a separate credential. Existing `/v1` paths are preserved; a bare host is completed with `/chat/completions`.
- Remote translation normally sends only the Skill name and author description. Sending a body excerpt requires an additional confirmation for a single Skill and is skipped in bulk jobs.
- API keys, private keys, bearer tokens, connection strings, absolute paths and similar sensitive input are blocked before a remote request.

See [PRIVACY.md](PRIVACY.md) for the full data boundary.

## Technology

- Tauri 2 and Rust
- React 19, TypeScript and Tailwind CSS
- SQLite and FTS5 using the `trigram` tokenizer
- Zustand and TanStack Query

## Development

### Requirements

- Node.js 24
- pnpm 11.7.0
- Stable Rust with `rustfmt` and `clippy`
- The [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform

Install dependencies and start the desktop application:

```powershell
pnpm install --frozen-lockfile
pnpm tauri dev
```

Run the browser-only demonstration with local mock data:

```powershell
pnpm dev
```

Quality checks:

```powershell
pnpm test
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

Build Windows installers:

```powershell
pnpm tauri build --ci --bundles nsis,msi -- --locked
```

## Repository structure

- `src/` — React presentation layer, state, IPC client and browser demo data.
- `src/i18n/` — English (UK), Simplified Chinese and Traditional Chinese catalogues.
- `src-tauri/src/` — typed commands, session indexing, Skill discovery, managed deployment, security scanning and AI description services.
- `src-tauri/migrations/` — versioned SQLite and FTS5 migrations.
- `assets/brand/` — original Skill Relay identity source assets.
- `src-tauri/installer-assets/` — NSIS and WiX installer artwork.
- `.github/workflows/` — pull-request checks and tag-driven Windows Releases.

## Publishing a release

Application versions in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` must match. Push a SemVer tag such as `v1.0.1`; the release workflow builds clean NSIS/MSI packages, verifies that exactly one of each was produced, generates SHA-256 checksums and publishes the files to GitHub Releases.

```powershell
git tag v1.0.1
git push origin v1.0.1
```

## Contributing and security

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), never in a public issue.

## Licence

The software source code and technical documentation are available under the [MIT License](LICENSE), copyright © 2026 Victor Kuo. The Skills Manager name, Skill Relay logo, application icons and installer artwork are covered by a separate [brand-use notice](BRAND_LICENSE.md); modified distributions should use their own name and visual identity.

## Trademark notice

Skills Manager is an independent community project. Codex and OpenAI are trademarks of OpenAI; Claude is a trademark of Anthropic; Cursor is a trademark of Anysphere. This project is not endorsed by, sponsored by or affiliated with those companies.
