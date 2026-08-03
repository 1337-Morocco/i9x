# Changelog

All notable changes to this project are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- npm workspaces at the repository root — one `npm ci`, one `npm run check`.
- CI: typecheck, lint and tests on every push and pull request, plus a job that
  builds the `.deb` and installs it on a clean runner.
- Tag-driven release workflow. Pushing `v*.*.*` builds and publishes using the
  run-scoped `GITHUB_TOKEN`, so no personal access token is needed.
- Test suite (`node:test`, no framework): 32 tests covering the cron parser and
  the nginx vhost renderer.
- `docs/` — architecture, development and deployment guides.
- `CONTRIBUTING.md`, `SECURITY.md`, `.editorconfig`, `.nvmrc`.
- Backend linting via oxlint, matching the frontend.

### Changed

- The desktop now shows all 14 services as icons instead of the contents of
  `~/Desktop`. Double-click launches, matching the dock and launchpad.
  `DesktopIcons` no longer touches the filesystem, and no longer creates
  `~/Desktop` as a side effect of mounting.

## [2.0.0]

### Added

- Releases and the one-line installer are hosted on GitHub. `get.sh` resolves
  the newest `.deb` from the releases API, falling back to `version.json` when
  the API is unreachable or rate-limited.
- `packaging/publish-github.sh` — creates the release and uploads the `.deb`
  plus manifest, reading its token from `~/.config/i9x/release.env`.

### Changed

- The update channel reads its manifest over HTTPS from
  `/releases/latest/download/version.json`. It was previously plain HTTP, which
  left update manifests tamperable in transit on a panel that installs packages
  as root.
- Package renamed `weblinux` → `i9x`. Existing installs are migrated in place;
  `/var/lib/weblinux` data is carried across.

[Unreleased]: https://github.com/1337-Morocco/i9x/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/1337-Morocco/i9x/releases/tag/v2.0.0
