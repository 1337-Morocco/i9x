# Deployment

## Install

On a Debian-family server (Debian, Ubuntu, Mint, Pop!_OS):

```bash
curl -fsSL https://raw.githubusercontent.com/1337-Morocco/i9x/main/packaging/get.sh | sudo bash
```

That resolves the newest `.deb` from the GitHub releases of
`1337-Morocco/i9x`, installs Docker + Compose, nginx and certbot, starts the
service, and fronts the panel on `:5633` with self-signed HTTPS.

```bash
… | sudo bash -s -- --no-expose        # install only, stay on localhost:3001
… | sudo bash -s -- --port 8443        # different public port
… | sudo bash -s -- --version v2.0.0   # pin a release
… | sudo bash -s -- --url https://…    # install a specific .deb
```

> Without `--no-expose` this puts a **root control panel on the public
> internet**. Use a long admin password and prefer restricting it to your own
> address: `sudo ufw allow from <your.ip> to any port 5633 proto tcp`.

## How the installer resolves a package

In order, stopping at the first that works:

1. `--url` / `$I9X_DEB_URL`
2. `--repo` / `$I9X_REPO` — the GitHub releases API, matching this machine's
   architecture
3. `1337-Morocco/i9x` releases (the built-in default)
4. `version.json` from `/releases/latest/download/` — the fallback when the API
   is unreachable or rate-limited (60/hr per IP, unauthenticated)

## Updating

```bash
sudo i9x-update            # check and install if newer
i9x-update --check         # report only, no root needed
sudo i9x-update --force    # reinstall the same version
```

Or use the Updates panel in Settings. Both read the same manifest:
`https://github.com/1337-Morocco/i9x/releases/latest/download/version.json`.
Override with `$I9X_UPDATE_URL`.

## Publishing a release by hand

CI handles this on a tag push — see [`development.md`](./development.md). If you
need to publish manually:

```bash
bash packaging/build-deb.sh --bump minor
mkdir -p ~/.config/i9x
printf 'GITHUB_TOKEN=%s\n' 'github_pat_…' > ~/.config/i9x/release.env
chmod 600 ~/.config/i9x/release.env
bash packaging/publish-github.sh
```

The token needs **Contents: Read and write** on the repo. It is read from
`~/.config/i9x/release.env` — outside the repo, so it cannot be committed. An
exported `GITHUB_TOKEN` takes precedence, which is how CI supplies it.

`publish-github.sh` creates the `vX.Y.Z` release if absent and uploads the
`.deb` plus `version.json`, replacing same-named assets so a rebuild of the same
version can be re-published. It refuses to run if `version.json` disagrees with
the version being published.

## What the package installs

| Path | Purpose |
|---|---|
| `/usr/bin/i9x` | the single SEA binary |
| `/usr/bin/i9x-update` | updater |
| `/usr/lib/i9x/public/` | built frontend |
| `/lib/systemd/system/i9x.service` | unit, enabled and started by postinst |
| `/var/lib/i9x/` | all state — **not** removed on uninstall |

## Uninstalling

```bash
sudo apt remove i9x       # keeps /var/lib/i9x
sudo apt purge i9x        # also removes configuration
```

State in `/var/lib/i9x` is deliberately preserved so a reinstall picks up where
it left off. Remove it by hand if you truly want a clean slate.
