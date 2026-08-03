# Development

## Requirements

- Node **24** (see `.nvmrc`; the floor is 22.5 because `node:sqlite` is used)
- Docker and nginx if you want the deploy/domain features to do anything

```bash
nvm use          # picks up .nvmrc
npm ci           # installs both workspaces
```

The repo is an npm workspace root, so `npm ci` at the top level installs
`backend/` and `frontend/` together. There is no need to install in each folder.

## Running

```bash
npm run dev            # frontend on :5173, proxies /api and /ws to :3001
npm run dev:backend    # backend on :3001, real shell, localhost only
```

Open <http://localhost:5173>. The first visit creates an admin account.

> The backend gives full shell access to your machine as the user running it.
> It binds to `127.0.0.1` only. Do not expose the dev server.

## Checks

```bash
npm run check       # typecheck + lint + test — what CI runs
npm run typecheck   # tsc across the frontend
npm run lint        # oxlint across both workspaces
npm test            # node:test across the backend
```

Tests live in `backend/test/` and use the built-in runner — no test framework
dependency, matching the no-native-modules constraint. They target the pure
logic where a silent bug is expensive:

- `cron.test.js` — the schedule parser behind every scheduled task
- `nginxconf.test.js` — the vhost renderer; a malformed config gets rejected by
  `nginx -t` and rolls the domain back

When adding tests, mirror what the real callers pass. Both suites initially
failed against invented fixtures — `render()` reads `lb.maxFails` and
`rate.enabled` directly and has no defaulting of its own, so a plausible-looking
fixture produces `max_fails=undefined` in the output rather than an error.

## Packaging

```bash
npm run package                    # → build/dist/i9x_<version>_<arch>.deb
bash packaging/build-deb.sh --bump minor
```

`build/` is generated and git-ignored in full.

## Releasing

Tag-driven; CI does the work:

```bash
bash packaging/build-deb.sh --bump minor   # updates packaging/VERSION
git commit -am "Release 2.1.0"
git tag v2.1.0 && git push --follow-tags
```

`.github/workflows/release.yml` verifies the tag matches `packaging/VERSION`,
runs the checks, builds the `.deb`, and publishes it with the run-scoped
`GITHUB_TOKEN`. No personal access token is needed.

To publish by hand instead, see [`deployment.md`](./deployment.md).

**Always bump the version when contents change.** `i9x-update` compares version
strings only — republishing a different build under the same version means
installed panels never see the upgrade.
