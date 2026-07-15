# Changelog

All notable changes to Skills Manager are documented here. The project follows Semantic Versioning.

## [1.0.0] - 2026-07-14

### Added

- Local Codex session indexing and Chinese/English substring search with highlights.
- Unified Codex, Claude Code and Cursor Skill discovery and health inspection.
- Content-addressed managed Skill storage and verified multi-agent deployment.
- Local static security scanning with redacted evidence.
- Local Chinese translation and capability-summary overlays.
- Ollama/LM Studio, OpenAI BYOK and generic OpenAI-compatible providers.
- Selective batch generation, failed-item retry and translated-item regeneration.
- English (UK), Simplified Chinese and Traditional Chinese interface languages.
- Future Dark and Future Light themes, density modes and desktop command centre.
- Custom Skills Manager identity, application icon and Windows installer artwork.

### Privacy and security

- No telemetry or automatic model calls during scanning.
- Operating-system credential storage for remote API keys.
- Remote-input minimisation, confirmation, sensitive-text blocking and strict output validation.

### Distribution

- Windows x64 NSIS and MSI packages with the offline WebView2 runtime.
- SHA-256 checksum file generated for every GitHub Release.
- Source code and technical documentation licensed under MIT by Victor Kuo,
  with a separate brand-use notice for the Skills Manager identity assets.
