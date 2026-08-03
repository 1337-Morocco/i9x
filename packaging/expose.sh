#!/usr/bin/env bash
#
# Expose i9x to the public over HTTPS on a chosen port, WITHOUT a domain.
#
#   sudo ./expose.sh [--port 5633] [--backend 127.0.0.1:3001]
#
# i9x keeps listening only on localhost:3001 (a root panel must not be
# public itself). This puts nginx in front on the chosen port, terminating TLS
# with a SELF-SIGNED certificate (no domain ⇒ no Let's Encrypt) and proxying
# HTTP + the /ws terminal WebSocket through to the backend.
#
# Browsers will warn once about the self-signed cert — that's expected; the
# traffic is still encrypted. For a trusted padlock you need a domain.
set -euo pipefail

if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'
else B=''; G=''; Y=''; R=''; C=''; N=''; fi
info() { echo "${C}==>${N} ${B}$*${N}"; }
ok()   { echo "${G}  ✓${N} $*"; }
warn() { echo "${Y}  ! ${N}$*"; }
die()  { echo "${R}✗ $*${N}" >&2; exit 1; }

PORT=5633
BACKEND="127.0.0.1:3001"
while [ $# -gt 0 ]; do
  case "$1" in
    --port)    PORT="${2:?}"; shift 2 ;;
    --backend) BACKEND="${2:?}"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done
[ "$(id -u)" = "0" ] || die "Please run as root:  sudo $0 $*"
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "Invalid port: $PORT"
command -v nginx >/dev/null 2>&1 || die "nginx is not installed. Install it first (the i9x installer does)."
command -v openssl >/dev/null 2>&1 || { info "Installing openssl"; apt-get install -y openssl; }

CERT_DIR="/etc/i9x"
CRT="$CERT_DIR/selfsigned.crt"
KEY="$CERT_DIR/selfsigned.key"
SITE="/etc/nginx/conf.d/i9x-expose.conf"

# ----- discover the public IP (for the cert SAN + the printed URL) ---------
info "Detecting public IP"
IP=""
for u in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
  IP="$(curl -fsS --max-time 5 "$u" 2>/dev/null | tr -d '[:space:]' || true)"
  [[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && break || IP=""
done
[ -n "$IP" ] || IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$IP" ] && ok "Public IP: $IP" || warn "Could not detect a public IP — using a generic certificate."

# ----- self-signed certificate -------------------------------------------
if [ -s "$CRT" ] && [ -s "$KEY" ]; then
  ok "Reusing existing certificate at $CRT"
else
  info "Generating a self-signed TLS certificate (valid 10 years)"
  mkdir -p "$CERT_DIR"; chmod 700 "$CERT_DIR"
  SAN="DNS:localhost,IP:127.0.0.1"
  [ -n "$IP" ] && SAN="$SAN,IP:$IP"
  openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
    -keyout "$KEY" -out "$CRT" \
    -subj "/CN=${IP:-i9x}" -addext "subjectAltName=${SAN}" >/dev/null 2>&1
  chmod 600 "$KEY"; chmod 644 "$CRT"
  ok "Certificate written to $CRT"
fi

# ----- nginx site (TLS + HTTP + WebSocket proxy) --------------------------
info "Writing nginx config → $SITE"
cat > "$SITE" <<NGINX
# Managed by i9x expose.sh — proxies public :$PORT (HTTPS) to $BACKEND.
map \$http_upgrade \$i9x_conn_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen $PORT ssl;
    listen [::]:$PORT ssl;
    server_name _;

    ssl_certificate     $CRT;
    ssl_certificate_key $KEY;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    client_max_body_size 100M;

    location / {
        proxy_pass http://$BACKEND;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    \$http_upgrade;
        proxy_set_header Connection \$i9x_conn_upgrade;   # WebSocket (/ws terminal)
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;   # keep terminal sockets alive
        proxy_send_timeout 3600s;
    }
}
NGINX

info "Testing nginx configuration"
nginx -t || die "nginx config test failed — see the error above. Left $SITE in place for inspection."
systemctl reload nginx || systemctl restart nginx
ok "nginx reloaded, listening on :$PORT"

# ----- firewall -----------------------------------------------------------
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  info "Opening port $PORT in ufw"; ufw allow "${PORT}/tcp" >/dev/null 2>&1 && ok "ufw allows ${PORT}/tcp"
else
  warn "ufw not active — make sure ${PORT}/tcp is open in your firewall AND your cloud provider's security group."
fi

# ----- done ---------------------------------------------------------------
echo
cat <<EOF
${B}i9x is now exposed over HTTPS.${N}
  URL:   ${C}https://${IP:-<your-public-ip>}:$PORT${N}
  Cert:  self-signed → your browser shows a one-time warning; click
         "Advanced → Proceed". Traffic is encrypted regardless.

${Y}⚠ Security — you are putting a ROOT control panel on the public internet:${N}
  • Use a long, unique admin password (login is email + password).
  • Consider restricting access to your IP, e.g.:
        sudo ufw allow from <your.ip.here> to any port $PORT proto tcp
        sudo ufw delete allow ${PORT}/tcp
  • For a trusted certificate (no browser warning) you need a domain —
    point one at this server and use the Domains app / certbot instead.

To undo:  sudo rm $SITE && sudo systemctl reload nginx && sudo ufw delete allow ${PORT}/tcp
EOF
