#!/usr/bin/env bash
# Build i9x into a single self-contained binary (Node SEA) and a .deb.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# The version lives in packaging/VERSION so the .deb, the binary and the
# published manifest can never disagree. Bump it as part of the build:
#   bash packaging/build-deb.sh --bump patch      0.1.0 -> 0.1.1
#   bash packaging/build-deb.sh --bump minor      0.1.0 -> 0.2.0
#   bash packaging/build-deb.sh --set 1.0.0
#   VERSION=0.4.2 bash packaging/build-deb.sh     one-off, file untouched
VERSION_FILE="$ROOT/packaging/VERSION"
BUMP="" SET_VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --bump) BUMP="${2:-patch}"; shift 2 ;;
    --set)  SET_VERSION="${2:-}"; shift 2 ;;
    --notes) RELEASE_NOTES="${2:-}"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ -n "$SET_VERSION" ]; then
  echo "$SET_VERSION" > "$VERSION_FILE"
elif [ -n "$BUMP" ]; then
  CUR="$(tr -d '[:space:]' < "$VERSION_FILE")"
  IFS=. read -r MAJ MIN PAT <<< "$CUR"
  case "$BUMP" in
    major) MAJ=$((MAJ + 1)); MIN=0; PAT=0 ;;
    minor) MIN=$((MIN + 1)); PAT=0 ;;
    patch) PAT=$((PAT + 1)) ;;
    *) echo "Unknown --bump level: $BUMP (use major|minor|patch)" >&2; exit 1 ;;
  esac
  echo "$MAJ.$MIN.$PAT" > "$VERSION_FILE"
  echo "==> Version bumped: $CUR -> $MAJ.$MIN.$PAT"
fi

VERSION="${VERSION:-$(tr -d '[:space:]' < "$VERSION_FILE")}"
RELEASE_NOTES="${RELEASE_NOTES:-}"
ARCH="$(dpkg --print-architecture)"
WORK="$ROOT/build"
STAGE="$WORK/stage"
DIST="$WORK/dist"
FUSE="NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"

rm -rf "$WORK"
mkdir -p "$WORK" "$DIST"

echo "==> [1/5] Building frontend (vite)"
( cd "$ROOT/frontend" && npm run build >/dev/null )

echo "==> [2/5] Bundling backend into one file (esbuild)"
( cd "$ROOT/backend" && npx --yes esbuild src/server.js \
    --bundle --platform=node --target=node22 \
    --external:node:sqlite \
    --external:bufferutil --external:utf-8-validate \
    --define:__I9X_VERSION__="\"$VERSION\"" \
    --outfile="$WORK/i9x-bundle.cjs" >/dev/null )

echo "==> [3/5] Creating single executable (Node SEA)"
cat > "$WORK/sea-config.json" <<JSON
{ "main": "$WORK/i9x-bundle.cjs", "output": "$WORK/sea-prep.blob", "disableExperimentalSEAWarning": true }
JSON
node --experimental-sea-config "$WORK/sea-config.json"
cp "$(command -v node)" "$WORK/i9x"
npx --yes postject "$WORK/i9x" NODE_SEA_BLOB "$WORK/sea-prep.blob" \
  --sentinel-fuse "$FUSE" >/dev/null
chmod +x "$WORK/i9x"

echo "==> [4/5] Assembling .deb tree"
mkdir -p "$STAGE/DEBIAN" "$STAGE/usr/bin" "$STAGE/usr/lib/i9x/public" "$STAGE/lib/systemd/system"
cp "$WORK/i9x" "$STAGE/usr/bin/i9x"
install -m 0755 "$ROOT/packaging/i9x-update" "$STAGE/usr/bin/i9x-update"
cp -r "$ROOT/frontend/dist/." "$STAGE/usr/lib/i9x/public/"
cp "$ROOT/packaging/i9x.service" "$STAGE/lib/systemd/system/i9x.service"
sed -e "s/{{VERSION}}/$VERSION/" -e "s/{{ARCH}}/$ARCH/" "$ROOT/packaging/control.in" > "$STAGE/DEBIAN/control"
for f in postinst prerm postrm; do install -m 0755 "$ROOT/packaging/$f" "$STAGE/DEBIAN/$f"; done

echo "==> [5/5] Building package"
DEB="$DIST/i9x_${VERSION}_${ARCH}.deb"
dpkg-deb --root-owner-group --build "$STAGE" "$DEB" >/dev/null
echo ""
echo "Built: $DEB"
ls -lh "$DEB" | awk '{print "Size:", $5}'
echo "Install with:  sudo apt install $DEB"

# Publish the fresh .deb + installer to the web root so the one-line installer
# (curl … | sudo bash) always serves the latest build. Override or disable with
# PUBLISH_DIR=/path  or  PUBLISH_DIR="".
PUBLISH_DIR="${PUBLISH_DIR-/home/jawad/install}"
if [ -n "$PUBLISH_DIR" ]; then
  echo ""
  echo "==> Publishing to $PUBLISH_DIR"
  mkdir -p "$PUBLISH_DIR"
  cp -f "$DEB" "$PUBLISH_DIR/"
  cp -f "$ROOT/packaging/get.sh" "$PUBLISH_DIR/get.sh"

  # version.json is what installed copies poll to learn a new build exists, and
  # what get.sh reads so the one-liner always pulls the current release. The
  # entry for this architecture is replaced; entries for others are preserved.
  BASE_URL="${BASE_URL:-http://elyosoft.online}"
  SHA="$(sha256sum "$DEB" | cut -d' ' -f1)"
  SIZE="$(stat -c%s "$DEB")"
  node -e '
    const fs = require("fs");
    const [file, version, arch, name, url, sha, size, notes] = process.argv.slice(1);
    let m = {};
    try { m = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    // A build for another arch published against an older version is stale, so
    // start a fresh builds map whenever the version number changes.
    if (m.version !== version) m.builds = {};
    m.name = "i9x";
    m.version = version;
    m.released = new Date().toISOString();
    if (notes) m.notes = notes; else delete m.notes;
    m.builds = m.builds || {};
    m.builds[arch] = { file: name, url, sha256: sha, size: Number(size) };
    fs.writeFileSync(file, JSON.stringify(m, null, 2) + "\n");
  ' "$PUBLISH_DIR/version.json" "$VERSION" "$ARCH" "$(basename "$DEB")" \
    "$BASE_URL/$(basename "$DEB")" "$SHA" "$SIZE" "$RELEASE_NOTES"

  # $PUBLISH_DIR is bind-mounted into the websvc-my-website container, which
  # elyosoft.online proxies to — so copying here publishes immediately.
  echo "Published: $(basename "$DEB")  +  get.sh  +  version.json (v$VERSION)"
  echo "Install:   curl -fsSL $BASE_URL/get.sh | sudo bash"
  echo "Upgrade:   sudo i9x-update      (or the Updates panel in Settings)"
fi
