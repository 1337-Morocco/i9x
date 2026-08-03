#!/usr/bin/env bash
#
# i9x one-line installer for Debian-family systems.
#
#   curl -fsSL http://elyosoft.online/get.sh | sudo bash
#
# By default it pulls the package from http://elyosoft.online/i9x_2.0.0_amd64.deb
# and exposes it publicly over HTTPS (self-signed) on port 5633.
#
# Options (pass after `bash -s --`):
#   --url  https://…/i9x_2.0.0_amd64.deb   install a specific .deb
#   --repo owner/repo [--version v0.1.0]        pull from GitHub releases
#   --port 5633                                 public HTTPS port (default 5633)
#   --no-expose                                 install only, keep localhost-only
#
#   curl -fsSL http://elyosoft.online/get.sh | sudo bash
#   curl -fsSL http://elyosoft.online/get.sh | sudo bash -s -- --port 8443
#   curl -fsSL http://elyosoft.online/get.sh | sudo bash -s -- --no-expose
#
# Or via environment:
#   I9X_DEB_URL=…   direct link to a .deb
#   I9X_REPO=owner/repo   GitHub repo to pull the release asset from
#
# It downloads the .deb, installs Docker + Compose, nginx + certbot and the core
# CLI tools, then installs and starts i9x. The whole script is wrapped in a
# function so a truncated download can never execute a half-command.
set -euo pipefail

main() {
  # ----- default source (override with --url / --repo / env if needed) -----
  BASE_URL="${I9X_BASE_URL:-http://elyosoft.online}"
  MANIFEST_URL="${I9X_UPDATE_URL:-$BASE_URL/version.json}"
  DEB_URL_DEFAULT="$BASE_URL/i9x_2.0.0_amd64.deb"   # last-resort fallback
  REPO_DEFAULT=""   # optional: "owner/repo" to pull from GitHub releases instead

  # ----- pretty output -----------------------------------------------------
  if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'
  else B=''; G=''; Y=''; R=''; C=''; N=''; fi
  info() { echo "${C}==>${N} ${B}$*${N}"; }
  ok()   { echo "${G}  ✓${N} $*"; }
  warn() { echo "${Y}  ! ${N}$*"; }
  die()  { echo "${R}✗ $*${N}" >&2; exit 1; }

  # ----- parse args --------------------------------------------------------
  # Not named VERSION: sourcing /etc/os-release below would overwrite that.
  local DEB_URL="${I9X_DEB_URL:-}" REPO="${I9X_REPO:-}" PIN_VERSION=""
  local EXPOSE=1 EXPOSE_PORT="${I9X_PORT:-5633}" EXPOSED_URL=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --url)        DEB_URL="${2:-}"; shift 2 ;;
      --repo)       REPO="${2:-}"; shift 2 ;;
      --version)    PIN_VERSION="${2:-}"; shift 2 ;;
      --port)       EXPOSE_PORT="${2:-}"; shift 2 ;;
      --no-expose)  EXPOSE=0; shift ;;
      -h|--help)    grep '^#' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) die "Unknown option: $1" ;;
    esac
  done
  [[ "$EXPOSE_PORT" =~ ^[0-9]+$ ]] && [ "$EXPOSE_PORT" -ge 1 ] && [ "$EXPOSE_PORT" -le 65535 ] || die "Invalid --port: $EXPOSE_PORT"

  # ----- preflight ---------------------------------------------------------
  command -v apt-get >/dev/null 2>&1 || die "This installer supports the Debian/Ubuntu family only (apt-get not found)."
  command -v dpkg    >/dev/null 2>&1 || die "dpkg not found — not a Debian-family system."

  local SUDO=""
  if [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null 2>&1 || die "Run as root, or install sudo. Try:  curl -fsSL … | sudo bash"
    SUDO="sudo"
  fi

  # A downloader.
  local DL=""
  if command -v curl >/dev/null 2>&1; then DL="curl -fsSL"
  elif command -v wget >/dev/null 2>&1; then DL="wget -qO-"
  else info "Installing curl"; $SUDO apt-get update -y && $SUDO apt-get install -y curl; DL="curl -fsSL"; fi

  # Sourced in a subshell so os-release's VERSION/NAME/ID cannot clobber ours.
  [ -r /etc/os-release ] && info "Detected: $( . /etc/os-release; echo "${PRETTY_NAME:-unknown}" )"
  local ARCH; ARCH="$(dpkg --print-architecture)"
  export DEBIAN_FRONTEND=noninteractive

  # ----- resolve the .deb URL ---------------------------------------------
  # Precedence: --url / $I9X_DEB_URL  →  --repo / $I9X_REPO (GitHub)
  #             →  REPO_DEFAULT (GitHub)   →  DEB_URL_DEFAULT (direct link)
  [ -n "$REPO" ] || REPO="$REPO_DEFAULT"
  if [ -z "$DEB_URL" ] && [ -n "$REPO" ]; then
    local api
    if [ -n "$PIN_VERSION" ]; then api="https://api.github.com/repos/$REPO/releases/tags/$PIN_VERSION"
    else api="https://api.github.com/repos/$REPO/releases/latest"; fi
    info "Finding the latest i9x release for ${ARCH} in ${REPO}"
    DEB_URL="$($DL "$api" \
      | grep -oE '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]+"' \
      | cut -d'"' -f4 \
      | grep -E "i9x_.*_(${ARCH}|all)\.deb$" \
      | head -n1 || true)"
    [ -n "$DEB_URL" ] || die "Couldn't find a i9x_*_${ARCH}.deb asset in ${REPO}. Pass --url directly."
  fi
  # Nothing explicit: ask the release host which build is current. version.json
  # is rewritten by every build, so the one-liner never serves a stale package.
  if [ -z "$DEB_URL" ]; then
    if [ -n "$PIN_VERSION" ]; then
      DEB_URL="${BASE_URL}/i9x_${PIN_VERSION#v}_${ARCH}.deb"
    else
      info "Looking up the latest release"
      local MANIFEST; MANIFEST="$($DL "$MANIFEST_URL" 2>/dev/null || true)"
      if [ -n "$MANIFEST" ]; then
        if command -v python3 >/dev/null 2>&1; then
          DEB_URL="$(printf '%s' "$MANIFEST" | python3 -c '
import json,sys
try: m = json.load(sys.stdin)
except Exception: sys.exit(0)
b = (m.get("builds") or {}).get(sys.argv[1]) or {}
print(b.get("url", ""))
' "$ARCH" 2>/dev/null || true)"
        fi
        # No python3 yet on a bare system — pull the URL out by hand.
        [ -n "$DEB_URL" ] || DEB_URL="$(printf '%s' "$MANIFEST" \
          | grep -oE '"url"[[:space:]]*:[[:space:]]*"[^"]*_'"$ARCH"'\.deb"' \
          | cut -d'"' -f4 | head -n1 || true)"
        [ -n "$DEB_URL" ] && ok "Latest: $(printf '%s' "$MANIFEST" | grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' | cut -d'"' -f4 | head -n1)"
      fi
      [ -n "$DEB_URL" ] || warn "Could not read $MANIFEST_URL — falling back to the pinned package."
    fi
  fi
  [ -n "$DEB_URL" ] || DEB_URL="$DEB_URL_DEFAULT"
  [ -n "$DEB_URL" ] || die "No download source. Pass --url <deb> or --repo <owner/repo>."
  # Catch a garbled URL here rather than letting curl fail deep in the install.
  [[ "$DEB_URL" =~ ^https?://[^[:space:]]+\.deb$ ]] \
    || die "Resolved a package URL that is not a .deb link: $DEB_URL"
  info "Package URL: $DEB_URL"

  # ----- download ----------------------------------------------------------
  # TMP stays global and the trap tolerates it being unset: the EXIT trap also
  # fires on early failures, when a function-local would already be out of scope.
  TMP="$(mktemp -d)"; trap '[ -n "${TMP:-}" ] && rm -rf "$TMP"' EXIT
  local DEB="$TMP/i9x.deb"
  info "Downloading package"
  if command -v curl >/dev/null 2>&1; then curl -fL# -o "$DEB" "$DEB_URL"
  else wget -O "$DEB" "$DEB_URL"; fi
  [ -s "$DEB" ] || die "Download failed or produced an empty file."

  local DEB_ARCH; DEB_ARCH="$(dpkg-deb -f "$DEB" Architecture 2>/dev/null || echo '?')"
  [ "$DEB_ARCH" = "all" ] || [ "$DEB_ARCH" = "$ARCH" ] || die "Package is for '$DEB_ARCH' but this machine is '$ARCH'."
  ok "Downloaded $(dpkg-deb -f "$DEB" Package 2>/dev/null || echo i9x) $(dpkg-deb -f "$DEB" Version 2>/dev/null) ($DEB_ARCH)"

  # ----- helpers -----------------------------------------------------------
  pkg_installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q "install ok installed"; }
  ensure() { local p="$1"; if pkg_installed "$p"; then ok "${2:-$p} present"; else info "Installing ${2:-$p}"; $SUDO apt-get install -y "$p" && ok "${2:-$p} installed"; fi; }
  apt_first() { for p in "$@"; do if apt-cache show "$p" >/dev/null 2>&1; then ensure "$p"; return 0; fi; done; return 1; }

  # ----- dependencies ------------------------------------------------------
  info "Updating package lists"; $SUDO apt-get update -y
  info "Core tools"; for p in git util-linux iproute2 procps curl ca-certificates; do ensure "$p"; done

  if command -v docker >/dev/null 2>&1; then ok "Docker present"
  else info "Installing Docker"; apt_first docker.io docker-ce || warn "Install Docker manually: https://docs.docker.com/engine/install/"; fi
  if docker compose version >/dev/null 2>&1 || command -v docker-compose >/dev/null 2>&1; then ok "Docker Compose present"
  else apt_first docker-compose-plugin docker-compose-v2 docker-compose || warn "Docker Compose not installed."; fi
  command -v docker >/dev/null 2>&1 && { $SUDO systemctl enable --now docker >/dev/null 2>&1 || warn "Could not start Docker service."; }

  info "Reverse proxy & SSL"; ensure nginx; ensure certbot; apt_first python3-certbot-nginx || warn "nginx certbot plugin missing."

  # ----- install i9x --------------------------------------------------
  # 2.0 renamed the package weblinux -> i9x. Retire the old record first; its
  # postrm leaves /var/lib/weblinux alone, so the new package's postinst can
  # migrate the database, apps and vhosts across.
  if pkg_installed weblinux; then
    info "Removing the previous weblinux package (data is kept and migrated)"
    $SUDO apt-get remove -y weblinux >/dev/null 2>&1 || $SUDO dpkg -r --force-depends weblinux || true
  fi

  info "Installing i9x"
  if ! $SUDO apt-get install -y "$DEB"; then
    warn "Fixing dependencies via dpkg"
    $SUDO dpkg -i "$DEB" || true
    $SUDO apt-get -f install -y
  fi
  $SUDO systemctl daemon-reload || true
  $SUDO systemctl enable --now i9x.service >/dev/null 2>&1 || true

  # ----- expose publicly over HTTPS (self-signed, no domain) ---------------
  if [ "$EXPOSE" = "1" ]; then
    info "Exposing i9x on port ${EXPOSE_PORT} (HTTPS, self-signed)"
    ensure nginx; pkg_installed openssl || ensure openssl
    local IP=""
    for u in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
      IP="$($DL "$u" 2>/dev/null | tr -d '[:space:]' || true)"
      [[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && break || IP=""
    done
    [ -n "$IP" ] || IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
    local CRT=/etc/i9x/selfsigned.crt KEY=/etc/i9x/selfsigned.key SITE=/etc/nginx/conf.d/i9x-expose.conf
    if [ -s "$CRT" ] && [ -s "$KEY" ]; then ok "Reusing existing certificate"
    else
      $SUDO mkdir -p /etc/i9x; $SUDO chmod 700 /etc/i9x
      local SAN="DNS:localhost,IP:127.0.0.1"; [ -n "$IP" ] && SAN="$SAN,IP:$IP"
      $SUDO openssl req -x509 -nodes -newkey rsa:2048 -days 3650 -keyout "$KEY" -out "$CRT" \
        -subj "/CN=${IP:-i9x}" -addext "subjectAltName=${SAN}" >/dev/null 2>&1
      $SUDO chmod 600 "$KEY"; $SUDO chmod 644 "$CRT"; ok "Self-signed certificate generated"
    fi
    $SUDO tee "$SITE" >/dev/null <<NGINX
# Managed by i9x get.sh — public :${EXPOSE_PORT} (HTTPS) → 127.0.0.1:3001
map \$http_upgrade \$i9x_conn_upgrade { default upgrade; '' close; }
server {
    listen ${EXPOSE_PORT} ssl;
    listen [::]:${EXPOSE_PORT} ssl;
    server_name _;
    ssl_certificate     $CRT;
    ssl_certificate_key $KEY;
    ssl_protocols       TLSv1.2 TLSv1.3;
    client_max_body_size 100M;
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    \$http_upgrade;
        proxy_set_header Connection \$i9x_conn_upgrade;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
NGINX
    if $SUDO nginx -t >/dev/null 2>&1; then
      $SUDO systemctl reload nginx || $SUDO systemctl restart nginx
      ok "nginx serving HTTPS on :${EXPOSE_PORT}"
      EXPOSED_URL="https://${IP:-<your-public-ip>}:${EXPOSE_PORT}"
    else
      warn "nginx config test failed — skipping exposure. Check: sudo nginx -t"
    fi
    if command -v ufw >/dev/null 2>&1 && $SUDO ufw status 2>/dev/null | grep -q "Status: active"; then
      $SUDO ufw allow "${EXPOSE_PORT}/tcp" >/dev/null 2>&1 && ok "ufw allows ${EXPOSE_PORT}/tcp"
    else
      warn "Open ${EXPOSE_PORT}/tcp in your firewall AND your cloud security group."
    fi
  fi

  # ----- done --------------------------------------------------------------
  echo
  if $SUDO systemctl is-active --quiet i9x.service; then ok "i9x is ${G}running${N}"
  else warn "Service not active — check: journalctl -u i9x -e"; fi
  cat <<EOF

${B}i9x installed.${N}
EOF
  if [ -n "$EXPOSED_URL" ]; then
    cat <<EOF
  Public:  ${C}${EXPOSED_URL}${N}   (HTTPS, self-signed — click through the browser warning)
  Local:   ${C}http://127.0.0.1:3001${N}
  First visit creates your admin account (email + password).

  Status: systemctl status i9x    Logs: journalctl -u i9x -f

${Y}⚠ This is a ROOT control panel now reachable on the internet.${N}
  • Use a long, unique admin password.
  • Lock it to your own IP instead of the whole world:
        sudo ufw allow from <your.ip> to any port ${EXPOSE_PORT} proto tcp
        sudo ufw delete allow ${EXPOSE_PORT}/tcp
  • The cert is self-signed (no domain). For a trusted padlock, point a
    domain here and issue a real cert from the Domains app.
  • Skip public exposure next time with:  ... | sudo bash -s -- --no-expose
EOF
  else
    cat <<EOF
  URL:    ${C}http://127.0.0.1:3001${N}   (localhost only)
  First visit creates your admin account (email + password).

  Status: systemctl status i9x    Logs: journalctl -u i9x -f

${Y}Security:${N} this is a root control panel — do not expose port 3001 without
TLS + a hardened reverse proxy in front.
EOF
  fi
}

main "$@"
