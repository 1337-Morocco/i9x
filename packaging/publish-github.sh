#!/usr/bin/env bash
#
# Publish the built .deb and its version.json manifest to GitHub releases.
#
#   GITHUB_TOKEN=ghp_… bash packaging/publish-github.sh
#   GITHUB_TOKEN=ghp_… bash packaging/publish-github.sh --version 2.0.0
#
# The token needs `contents: write` on the repo (a fine-grained PAT with
# Contents: Read and write, or a classic PAT with the `repo` scope).
#
# It creates the release for vX.Y.Z if it doesn't exist yet, then uploads every
# build/dist/i9x_<version>_*.deb plus version.json. Re-running replaces assets
# of the same name, so a rebuild of the same version can be re-published.
#
# Options:
#   --version X.Y.Z   publish this version instead of packaging/VERSION
#   --draft           create the release as a draft
#   --notes "text"    release body (default: a pointer to the install one-liner)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="${GH_REPO:-1337-Morocco/i9x}"

# Credentials live outside the repo so they can't be committed by accident.
# An exported GITHUB_TOKEN still wins, which is what CI will do.
ENV_FILE="${I9X_RELEASE_ENV:-$HOME/.config/i9x/release.env}"
if [ -z "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ] && [ -r "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi
TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"

if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'
else B=''; G=''; Y=''; R=''; C=''; N=''; fi
info() { echo "${C}==>${N} ${B}$*${N}"; }
ok()   { echo "${G}  ✓${N} $*"; }
warn() { echo "${Y}  ! ${N}$*"; }
die()  { echo "${R}✗ $*${N}" >&2; exit 1; }

VERSION="" DRAFT="false" NOTES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --draft)   DRAFT="true"; shift ;;
    --notes)   NOTES="${2:-}"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

if [ -z "$TOKEN" ]; then
  die "No token. Either export GITHUB_TOKEN, or store it once:
    mkdir -p ~/.config/i9x
    printf 'GITHUB_TOKEN=%s\n' 'github_pat_…' > $ENV_FILE
    chmod 600 $ENV_FILE
  It needs Contents: Read and write on $REPO."
fi
command -v curl >/dev/null 2>&1 || die "curl not found."
command -v node >/dev/null 2>&1 || die "node not found (used to read API responses)."

VERSION="${VERSION:-$(tr -d '[:space:]' < "$ROOT/packaging/VERSION")}"
TAG="v$VERSION"
DIST="$ROOT/build/dist"
MANIFEST="$DIST/version.json"

# ---- collect the assets --------------------------------------------------
shopt -s nullglob
DEBS=("$DIST"/i9x_"$VERSION"_*.deb)
shopt -u nullglob
[ ${#DEBS[@]} -gt 0 ] || die "No $DIST/i9x_${VERSION}_*.deb — run packaging/build-deb.sh first."
[ -f "$MANIFEST" ]    || die "No $MANIFEST — run packaging/build-deb.sh first."

# The manifest must describe the version being published, or installed copies
# would poll it and be told to 'upgrade' to something that isn't there.
MANIFEST_VERSION="$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version||""))}catch{}' "$MANIFEST")"
[ "$MANIFEST_VERSION" = "$VERSION" ] \
  || die "version.json says '$MANIFEST_VERSION' but publishing '$VERSION'. Rebuild so they agree."

info "Publishing $TAG to $REPO"
for d in "${DEBS[@]}"; do echo "    $(basename "$d")  ($(du -h "$d" | cut -f1))"; done
echo "    version.json"

api() {  # api <method> <url> [body]
  local method="$1" url="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$url" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      -d "$body"
  else
    curl -sS -X "$method" "$url" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28"
  fi
}

jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const v=process.argv[1].split(".").reduce((a,k)=>a==null?a:a[k],o);process.stdout.write(v==null?"":String(v))}catch{}})' "$1"; }

# ---- find or create the release -----------------------------------------
REL="$(api GET "https://api.github.com/repos/$REPO/releases/tags/$TAG")"
RELEASE_ID="$(printf '%s' "$REL" | jget id)"

if [ -z "$RELEASE_ID" ]; then
  info "Creating release $TAG"
  [ -n "$NOTES" ] || NOTES="Install or upgrade:

\`\`\`bash
curl -fsSL https://raw.githubusercontent.com/$REPO/main/packaging/get.sh | sudo bash
\`\`\`

Already running i9x? \`sudo i9x-update\` picks this up, or use the Updates panel in Settings."
  BODY="$(node -e '
    const [tag, name, notes, draft] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({
      tag_name: tag, name, body: notes, draft: draft === "true", prerelease: false,
    }));
  ' "$TAG" "i9x $VERSION" "$NOTES" "$DRAFT")"
  REL="$(api POST "https://api.github.com/repos/$REPO/releases" "$BODY")"
  RELEASE_ID="$(printf '%s' "$REL" | jget id)"
  [ -n "$RELEASE_ID" ] \
    || die "Could not create the release: $(printf '%s' "$REL" | jget message)"
  ok "Release created (id $RELEASE_ID)"
else
  ok "Release $TAG already exists (id $RELEASE_ID) — replacing assets"
fi

# ---- upload each asset ---------------------------------------------------
upload() {  # upload <path> <content-type>
  local path="$1" ctype="$2" name; name="$(basename "$path")"

  # GitHub rejects a duplicate asset name, so retire the old one first.
  local old
  old="$(api GET "https://api.github.com/repos/$REPO/releases/$RELEASE_ID/assets?per_page=100" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);const m=(Array.isArray(a)?a:[]).find(x=>x.name===process.argv[1]);process.stdout.write(m?String(m.id):"")}catch{}})' "$name")"
  if [ -n "$old" ]; then
    api DELETE "https://api.github.com/repos/$REPO/releases/assets/$old" >/dev/null
    warn "Replaced existing $name"
  fi

  info "Uploading $name"
  local res
  res="$(curl -sS -X POST \
    "https://uploads.github.com/repos/$REPO/releases/$RELEASE_ID/assets?name=$name" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    -H "Content-Type: $ctype" \
    --data-binary @"$path")"
  local url; url="$(printf '%s' "$res" | jget browser_download_url)"
  [ -n "$url" ] || die "Upload of $name failed: $(printf '%s' "$res" | jget message)"
  ok "$url"
}

for d in "${DEBS[@]}"; do upload "$d" "application/vnd.debian.binary-package"; done
upload "$MANIFEST" "application/json"

echo
cat <<EOF
${B}Published $TAG.${N}
  Release:  ${C}https://github.com/$REPO/releases/tag/$TAG${N}
  Install:  ${C}curl -fsSL https://raw.githubusercontent.com/$REPO/main/packaging/get.sh | sudo bash${N}
  Manifest: ${C}https://github.com/$REPO/releases/latest/download/version.json${N}

Installed copies see this within their next update check (or: sudo i9x-update).
EOF
