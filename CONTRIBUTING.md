# Contributing

Thanks for taking a look. This is a small project — an issue describing the
problem is as welcome as a pull request.

## Getting set up

See [`docs/development.md`](docs/development.md). Short version:

```bash
nvm use && npm ci
npm run dev          # frontend :5173
npm run dev:backend  # backend :3001
```

## Before opening a pull request

```bash
npm run check    # typecheck + lint + test — the same thing CI runs
```

CI additionally builds the `.deb` and installs it on a clean runner, so a change
that breaks packaging is caught even if the app itself compiles.

## What to keep in mind

Two constraints shape most decisions in this codebase:

- **No native modules.** i9x ships as a single Node SEA binary that must install
  without a compiler. That is why the terminal uses the `script` utility rather
  than `node-pty`, and storage uses `node:sqlite` rather than `better-sqlite3`.
  A dependency needing `node-gyp` will not be accepted.
- **It runs offline.** Servers often have no outbound internet. No CDN assets,
  no webfonts, no runtime downloads.

Beyond that:

- Match the surrounding style. There is no formatter — `oxlint` covers
  correctness, `.editorconfig` covers whitespace.
- Comments should explain *why*, not restate the code. The existing comments are
  a decent guide to the expected level.
- Anything that generates a config which nginx or Docker must accept should have
  a test. `backend/test/nginxconf.test.js` shows the shape.

## Tests

`node:test`, no framework. Add files as `backend/test/<module>.test.js`.

Build fixtures from what the real callers actually pass — several modules read
fields directly with no defaulting, so an invented fixture produces plausible
but wrong output rather than an error.

## Commits

Imperative subject line, and a body explaining why when it is not obvious.
Mention user-visible changes in `CHANGELOG.md` under "Unreleased".

## Releasing

Maintainers only — see [`docs/development.md`](docs/development.md#releasing).
Always bump the version when the contents change: `i9x-update` compares version
strings, so republishing different bytes under the same version means installed
panels never see the upgrade.

## Security

Please do not open a public issue for a vulnerability. See
[`SECURITY.md`](SECURITY.md).
