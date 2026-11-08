# Releasing

A release is published by `.github/workflows/desktop.yml` when a push to
`main` carries a version that has no release yet. To make one:

1. Raise the version in `package.json`, `src-tauri/tauri.conf.json` and
   `src-tauri/Cargo.toml` (the test job checks they agree).
2. Write the notes in `docs/releases/<version>.md`.
3. Merge to `main`. The workflow tests, builds the Windows installer and the
   portable zip, and publishes `v<version>` with both.

Two pull requests in flight must not carry the same version: the later one to
merge raises its version above `main`'s.
