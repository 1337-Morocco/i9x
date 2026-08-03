#!/usr/bin/env bash
#
# i9x installer for Debian-family systems (Debian, Ubuntu, Mint, Pop!_OS…).
#
# Installs the i9x .deb and every runtime dependency it needs:
#   • core tools:  git, util-linux, iproute2, procps, curl, ca-certificates
#   • Docker + Compose      (app/database deployment)
#   • nginx, certbot         (custom domains + Let's Encrypt SSL)
#
# Usage:
#   sudo ./install.sh [path/to/i9x_x.y.z_arch.deb]
#
# If no .deb path is given, the newest i9x_*.deb next to this script or
# under ../build/dist is used.
set -euo pipefail

# ---- pretty output -------------------------------------------------------
if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'
else B=''; G=''; Y=''; R=''; C=''; N=''; fi
info() { echo "${C}==>${N} ${B}$*${N}"; }
ok()   { echo "${G}  ✓${N} $*"; }
warn() { echo "${Y}  ! ${N}$*"; }
die()  { echo "${R}✗ $*${N}" >&2; exit 1; }

# ---- preflight -----------------------------------------------------------
[ "$(id -u)" = "0" ] || die "Please run as root:  sudo $0 $*"

command -v apt-get >/dev/null 2>&1 || die "This installer supports the Debian/Ubuntu family only (apt-get not found)."
command -v dpkg    >/dev/null 2>&1 || die "dpkg not found — not a Debian-family system."

if [ -r /etc/os-release ]; then . /etc/os-release; info "Detected: ${PRETTY_NAME:-unknown}"; fi

export DEBIAN_FRONTEND=noninteractive
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ---- locate the .deb -----------------------------------------------------
DEB="${1:-}"
if [ -z "$DEB" ]; then
  DEB="$(ls -t "$SCRIPT_DIR"/i9x_*.deb "$SCRIPT_DIR"/../build/dist/i9x_*.deb 2>/dev/null | head -n1 || true)"
fi
[ -n "$DEB" ] && [ -f "$DEB" ] || die "No .deb found. Pass one:  sudo $0 path/to/i9x_*.deb"
DEB="$(readlink -f "$DEB")"

DEB_ARCH="$(dpkg-deb -f "$DEB" Architecture 2>/dev/null || echo '?')"
HOST_ARCH="$(dpkg --print-architecture)"
[ "$DEB_ARCH" = "all" ] || [ "$DEB_ARCH" = "$HOST_ARCH" ] || \
  die "Package is for '$DEB_ARCH' but this machine is '$HOST_ARCH'. Build a matching .deb."
info "Package: $(basename "$DEB")  (arch: $DEB_ARCH)"

# ---- helpers -------------------------------------------------------------
pkg_installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q "install ok installed"; }

# Install the first candidate package that exists in the apt repos.
apt_first_available() {
  for p in "$@"; do
    if apt-cache show "$p" >/dev/null 2>&1; then
      if pkg_installed "$p"; then ok "$p already installed"; return 0; fi
      info "Installing $p"; apt-get install -y "$p" && { ok "$p installed"; return 0; }
    fi
  done
  return 1
}

ensure() {  # ensure <pkg> [friendly-name]
  local p="$1"
  if pkg_installed "$p"; then ok "${2:-$p} already installed"; return 0; fi
  info "Installing ${2:-$p}"; apt-get install -y "$p" && ok "${2:-$p} installed"
}

# ---- refresh apt ---------------------------------------------------------
info "Updating package lists"
apt-get update -y

# ---- core CLI tools i9x shells out to -------------------------------
info "Core tools"
for p in git util-linux iproute2 procps curl ca-certificates; do ensure "$p"; done

# ---- Docker + Compose (app & database deployment) ------------------------
if command -v docker >/dev/null 2>&1; then
  ok "Docker already installed ($(docker --version 2>/dev/null | cut -d, -f1))"
else
  info "Installing Docker engine"
  apt_first_available docker.io docker-ce || warn "Could not install Docker from apt — install it manually (https://docs.docker.com/engine/install/)."
fi
# Compose (v2 plugin preferred; fall back to older packages)
if docker compose version >/dev/null 2>&1 || command -v docker-compose >/dev/null 2>&1; then
  ok "Docker Compose available"
else
  apt_first_available docker-compose-plugin docker-compose-v2 docker-compose || warn "Docker Compose not installed (WordPress manager needs it)."
fi
# Make sure the daemon is enabled and running
if command -v docker >/dev/null 2>&1; then
  systemctl enable --now docker >/dev/null 2>&1 || warn "Could not start the Docker service automatically."
fi

# ---- nginx + certbot (custom domains + SSL) ------------------------------
info "Reverse proxy & SSL"
ensure nginx
ensure certbot
apt_first_available python3-certbot-nginx || warn "python3-certbot-nginx not installed — the nginx SSL plugin may be missing."

# ---- install i9x ----------------------------------------------------
# 2.0 renamed the package weblinux -> i9x. Retire the old record first; its
# postrm leaves /var/lib/weblinux alone, so the new package's postinst can
# migrate the database, apps and vhosts across.
if pkg_installed weblinux; then
  info "Removing the previous weblinux package (data is kept and migrated)"
  apt-get remove -y weblinux >/dev/null 2>&1 || dpkg -r --force-depends weblinux || true
fi

info "Installing i9x"
if ! apt-get install -y "$DEB"; then
  warn "apt reported an issue — retrying with dpkg + dependency fix"
  dpkg -i "$DEB" || true
  apt-get -f install -y
fi

# The package's postinst enables & starts the service; make sure of it.
systemctl daemon-reload || true
systemctl enable --now i9x.service >/dev/null 2>&1 || true

# ---- done ----------------------------------------------------------------
echo
if systemctl is-active --quiet i9x.service; then
  ok "i9x is ${G}running${N}"
else
  warn "i9x service is not active — check:  journalctl -u i9x -e"
fi
cat <<EOF

${B}i9x installed.${N}
  URL:     ${C}http://127.0.0.1:3001${N}   (localhost only by default)
  First visit creates your admin account (email + password).

  Status:  systemctl status i9x
  Logs:    journalctl -u i9x -f
  Stop:    sudo systemctl stop i9x

${Y}Security:${N} this is a root control panel. Do not expose port 3001 to the
internet without TLS + a hardened reverse proxy in front.
EOF
