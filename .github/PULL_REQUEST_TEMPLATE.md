## Summary

Describe the user-visible outcome and the reason for the change.

## Verification

- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`
- [ ] `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- [ ] `cargo test --locked --manifest-path src-tauri/Cargo.toml`

## Review checklist

- [ ] English (UK), Simplified Chinese and Traditional Chinese strings are in sync.
- [ ] Database changes use a new forward-only migration.
- [ ] UI changes include light and dark screenshots.
- [ ] Network, AI-provider, credential, filesystem and process effects are documented.
- [ ] No API key, personal path, session text, generated binary, database or log is included.
