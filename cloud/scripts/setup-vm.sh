#!/bin/bash
# Pane Cloud VM Setup Script
# Installs all dependencies and configures a daemon-first hosted workspace
# with optional noVNC fallback/debug access.
# Run on a fresh Ubuntu 24.04 VM as root
#
# Usage: sudo bash setup-vm.sh [--pane-version VERSION]

set -eo pipefail

# Ensure full PATH — GCP startup scripts run with minimal PATH
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

PANE_VERSION="${1:-latest}"
DISPLAY_NUM=99
RESOLUTION="1920x1080x24"
VNC_PORT=5900
NOVNC_PORT=6080
PANE_USER="Pane"

echo "=== Pane Cloud VM Setup ==="
echo "Display: :${DISPLAY_NUM} @ ${RESOLUTION}"
echo "VNC port: ${VNC_PORT}"
echo "noVNC port: ${NOVNC_PORT}"
echo ""

# ============================================================
# 1. System packages
# ============================================================
echo "[1/10] Installing system packages..."
export DEBIAN_FRONTEND=noninteractive

apt-get update -qq
apt-get install -y -qq \
  xvfb \
  x11vnc \
  novnc \
  websockify \
  fluxbox \
  supervisor \
  nginx \
  certbot \
  python3-certbot-nginx \
  git \
  tmux \
  curl \
  wget \
  unzip \
  jq \
  htop \
  dbus-x11 \
  xdg-utils \
  fonts-liberation \
  fonts-noto-color-emoji \
  > /dev/null

# Electron / Chromium dependencies
apt-get install -y -qq \
  libnss3 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libgtk-3-0 \
  libgbm1 \
  libasound2t64 \
  libxss1 \
  libxtst6 \
  libcups2 \
  libdrm2 \
  libxkbcommon0 \
  libgdk-pixbuf-2.0-0 \
  libx11-xcb1 \
  libnotify4 \
  > /dev/null

echo "  Done."

# Rehash so newly installed binaries (curl, wget, etc.) are found
hash -r

# ============================================================
# 2. Read instance metadata for hosted workspace bootstrap
# ============================================================
metadata_value() {
  local key="$1"
  curl -sf -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/${key}" 2>/dev/null || true
}

normalize_bool() {
  local value
  value="$(echo "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    1|true|yes|on)
      echo "true"
      ;;
    *)
      echo "false"
      ;;
  esac
}

REMOTE_CLIENT_ID="$(metadata_value remote-client-id)"
REMOTE_CLIENT_LABEL="$(metadata_value remote-client-label)"
REMOTE_CLIENT_TOKEN="$(metadata_value remote-client-token)"
REMOTE_DAEMON_PORT="$(metadata_value remote-daemon-port)"
ENABLE_NOVNC_FALLBACK="$(normalize_bool "$(metadata_value enable-novnc-fallback)")"

if ! [[ "$REMOTE_DAEMON_PORT" =~ ^[0-9]+$ ]] || [ "$REMOTE_DAEMON_PORT" -lt 1 ] || [ "$REMOTE_DAEMON_PORT" -gt 65535 ]; then
  REMOTE_DAEMON_PORT=42137
fi

if [ -z "$REMOTE_CLIENT_LABEL" ]; then
  REMOTE_CLIENT_LABEL="Pane Cloud Workspace"
fi

echo "[2/10] Hosted workspace metadata"
echo "  Daemon port: ${REMOTE_DAEMON_PORT}"
echo "  Remote client id: ${REMOTE_CLIENT_ID:-<missing>}"
echo "  noVNC fallback enabled: ${ENABLE_NOVNC_FALLBACK}"

# ============================================================
# 3. Node.js 22 LTS
# ============================================================
echo "[3/10] Installing Node.js 22 LTS..."

# Always ensure we meet the repo development floor (>= 22.18).
NODE_VERSION=$(node --version 2>/dev/null | sed 's/^v//' || echo "0.0.0")
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
NODE_MINOR=$(echo "$NODE_VERSION" | cut -d. -f2)
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 18 ]; }; then
  echo "  Current Node version: $(node --version 2>/dev/null || echo 'none'). Upgrading to Node 22.18+..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs > /dev/null
fi

# Rehash to pick up new node/npm paths
hash -r

# pnpm - use full path to npm since we're running as root
if ! command -v pnpm &> /dev/null; then
  echo "  Installing pnpm..."
  /usr/bin/npm install -g pnpm > /dev/null 2>&1 || npm install -g pnpm > /dev/null 2>&1
fi

echo "  Node $(node --version), pnpm $(pnpm --version 2>/dev/null || echo 'not installed')"

# ============================================================
# 4. GitHub CLI
# ============================================================
echo "[4/10] Installing GitHub CLI..."
if ! command -v gh &> /dev/null; then
  (type -p wget >/dev/null || apt-get install wget -y -qq) \
    && mkdir -p -m 755 /etc/apt/keyrings \
    && wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update -qq > /dev/null \
    && apt-get install gh -y -qq > /dev/null
fi
echo "  Done."

# ============================================================
# 5. Claude Code CLI
# ============================================================
echo "[5/10] Installing Claude Code CLI..."
if ! command -v claude &> /dev/null; then
  # Install latest Claude Code (intentionally unpinned — VM should have newest version)
  npm install -g @anthropic-ai/claude-code > /dev/null 2>&1 || true
fi
echo "  Done."

# ============================================================
# 6. Install Pane
# ============================================================
echo "[6/10] Installing Pane..."
ARCH=$(dpkg --print-architecture)
if [ ! -f /usr/bin/Pane ]; then
  # Download the latest Pane AppImage from GitHub Releases
  RELEASE_URL=$(curl -fsSL https://api.github.com/repos/greenfield-inc/Pane/releases/latest \
    | jq -r ".assets[] | select(.name | test(\"Pane.*${ARCH}.*\\\\.AppImage$\")) | .browser_download_url" \
    | head -1)

  if [ -n "${RELEASE_URL}" ] && [ "${RELEASE_URL}" != "null" ]; then
    echo "  Downloading from ${RELEASE_URL}..."
    curl -fsSL -o /usr/bin/Pane "${RELEASE_URL}"
    chmod +x /usr/bin/Pane
  else
    # Fallback: try .deb package
    DEB_URL=$(curl -fsSL https://api.github.com/repos/greenfield-inc/Pane/releases/latest \
      | jq -r ".assets[] | select(.name | test(\"Pane.*${ARCH}.*\\\\.deb$\")) | .browser_download_url" \
      | head -1)

    if [ -n "${DEB_URL}" ] && [ "${DEB_URL}" != "null" ]; then
      echo "  Downloading .deb from ${DEB_URL}..."
      curl -fsSL -o /tmp/Pane.deb "${DEB_URL}"
      dpkg -i /tmp/Pane.deb || apt-get install -f -y -qq > /dev/null
      rm -f /tmp/Pane.deb
    else
      echo "  WARNING: No Pane release found for ${ARCH}. The Pane supervisor process will not start."
      echo "  Install Pane manually and place the binary at /usr/bin/Pane"
    fi
  fi
fi
echo "  Done."

# Verify Pane was installed
if [ ! -f /usr/bin/Pane ] && ! command -v Pane &>/dev/null; then
  echo "FATAL: Pane installation failed. Cannot continue."
  exit 1
fi

# ============================================================
# 7. Create Pane user
# ============================================================
echo "[7/10] Setting up Pane user..."
if ! id "${PANE_USER}" &>/dev/null; then
  useradd -m -s /bin/bash "${PANE_USER}"
fi

# Create standard directories
sudo -u "${PANE_USER}" mkdir -p \
  "/home/${PANE_USER}/.pane" \
  "/home/${PANE_USER}/.claude" \
  "/home/${PANE_USER}/.config/gh" \
  "/home/${PANE_USER}/.ssh" \
  "/home/${PANE_USER}/projects"

echo "  User: ${PANE_USER}"

# Configure fluxbox for clean kiosk-like experience
FLUXBOX_DIR="/home/${PANE_USER}/.fluxbox"
sudo -u "${PANE_USER}" mkdir -p "${FLUXBOX_DIR}"

# Remove title bar from Pane/Electron windows
# Match on both name and class since Electron apps may vary
cat > "${FLUXBOX_DIR}/apps" << 'FLUXBOX_APPS_EOF'
[app] (name=Pane)
  [Deco] {NONE}
  [Maximized] {yes}
[end]
[app] (class=Pane)
  [Deco] {NONE}
  [Maximized] {yes}
[end]
[app] (class=Electron)
  [Deco] {NONE}
  [Maximized] {yes}
[end]
FLUXBOX_APPS_EOF
chown "${PANE_USER}:${PANE_USER}" "${FLUXBOX_DIR}/apps"

# Hide the toolbar completely - must clear tools and set visible false
# See: https://forums.linuxmint.com/viewtopic.php?t=40637
cat > "${FLUXBOX_DIR}/init" << 'FLUXBOX_INIT_EOF'
session.screen0.toolbar.visible: false
session.screen0.toolbar.tools:
session.screen0.workspaces: 1
session.screen0.workspacewarping: false
FLUXBOX_INIT_EOF
chown "${PANE_USER}:${PANE_USER}" "${FLUXBOX_DIR}/init"

echo "  Fluxbox configured (no title bar, no toolbar)"

# ============================================================
# 8. Get or generate optional VNC password
# ============================================================
echo "[8/10] Setting up optional VNC password..."
VNC_PASSWORD_FILE="/home/${PANE_USER}/.vnc_password"

# Try to get VNC password from instance metadata (set by Terraform)
VNC_PASSWORD=$(curl -sf -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/vnc-password" 2>/dev/null || echo "")

if [ -z "$VNC_PASSWORD" ]; then
  # Fallback: generate a random password
  echo "  No password in metadata, generating random password..."
  VNC_PASSWORD=$(openssl rand -base64 12)
else
  echo "  Using password from instance metadata."
fi

echo "${VNC_PASSWORD}" > "${VNC_PASSWORD_FILE}"
chmod 600 "${VNC_PASSWORD_FILE}"
chown "${PANE_USER}:${PANE_USER}" "${VNC_PASSWORD_FILE}"
echo "  VNC password saved to ${VNC_PASSWORD_FILE}"

# ============================================================
# 9. Prepare Pane daemon config and supervisord
# ============================================================
echo "[9/10] Preparing Pane daemon config..."

# Get Pane user's UID for XDG_RUNTIME_DIR
PANE_UID=$(id -u "${PANE_USER}")
PANE_CONFIG_FILE="/home/${PANE_USER}/.pane/config.json"
REMOTE_CLIENT_TOKEN_HASH=""

if [ -n "$REMOTE_CLIENT_TOKEN" ]; then
  REMOTE_CLIENT_TOKEN_HASH="$(printf '%s' "$REMOTE_CLIENT_TOKEN" | sha256sum | awk '{print $1}')"
fi

HOST_CLIENTS_JSON='[]'
if [ -n "$REMOTE_CLIENT_ID" ] && [ -n "$REMOTE_CLIENT_TOKEN_HASH" ]; then
  HOST_CLIENTS_JSON="$(jq -cn \
    --arg id "$REMOTE_CLIENT_ID" \
    --arg label "$REMOTE_CLIENT_LABEL" \
    --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg tokenHash "$REMOTE_CLIENT_TOKEN_HASH" \
    '[{
      id: $id,
      label: $label,
      createdAt: $createdAt,
      tokenHash: $tokenHash
    }]')"
else
  echo "  WARNING: remote client metadata is incomplete; hosted daemon auth will rely on any existing local config."
fi

EXISTING_PANE_CONFIG='{}'
if [ -f "$PANE_CONFIG_FILE" ]; then
  EXISTING_PANE_CONFIG="$(cat "$PANE_CONFIG_FILE" 2>/dev/null || echo '{}')"
fi

UPDATED_PANE_CONFIG="$(
  printf '%s' "$EXISTING_PANE_CONFIG" | jq \
    --argjson daemonPort "$REMOTE_DAEMON_PORT" \
    --argjson hostClients "$HOST_CLIENTS_JSON" \
    '
      .remoteDaemon = (.remoteDaemon // {})
      | .remoteDaemon.host = (.remoteDaemon.host // {})
      | .remoteDaemon.host.config = {
          enabled: true,
          listenHost: "127.0.0.1",
          listenPort: $daemonPort,
          pairingRequired: true,
          allowInsecureHttpOnLoopback: true
        }
      | if ($hostClients | length) > 0
          then .remoteDaemon.host.clients = $hostClients
          else .remoteDaemon.host.clients = (.remoteDaemon.host.clients // [])
        end
      | .remoteDaemon.client = (.remoteDaemon.client // {
          profiles: [],
          activeProfileId: null,
          mode: "local"
        })
    '
)"

printf '%s\n' "$UPDATED_PANE_CONFIG" > "$PANE_CONFIG_FILE"
chown "${PANE_USER}:${PANE_USER}" "$PANE_CONFIG_FILE"
chmod 600 "$PANE_CONFIG_FILE"

echo "  Pane daemon config written to ${PANE_CONFIG_FILE}"
echo "  Configuring supervisord..."

cat > /etc/supervisor/conf.d/pane-stack.conf << SUPERVISOR_EOF
; ============================================================
; Pane Cloud Hosted Workspace Stack
; ============================================================

[program:xvfb]
command=/usr/bin/Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset
priority=10
autorestart=true
stdout_logfile=/var/log/supervisor/xvfb.log
stderr_logfile=/var/log/supervisor/xvfb-error.log

[program:pane-daemon]
command=/usr/bin/Pane --no-sandbox --daemon-headless --pane-dir /home/${PANE_USER}/.pane
priority=20
autorestart=true
environment=DISPLAY=":99",HOME="/home/${PANE_USER}",XDG_RUNTIME_DIR="/run/user/${PANE_UID}"
user=${PANE_USER}
directory=/home/${PANE_USER}
stdout_logfile=/var/log/supervisor/pane-daemon.log
stderr_logfile=/var/log/supervisor/pane-daemon-error.log
startsecs=5
startretries=5
SUPERVISOR_EOF

SUPERVISOR_GROUP_PROGRAMS="xvfb,pane-daemon"

if [ "$ENABLE_NOVNC_FALLBACK" = "true" ]; then
  cat >> /etc/supervisor/conf.d/pane-stack.conf << SUPERVISOR_FALLBACK_EOF

[program:fluxbox]
command=/usr/bin/fluxbox
priority=30
autorestart=true
environment=DISPLAY=":99"
user=${PANE_USER}
stdout_logfile=/var/log/supervisor/fluxbox.log
stderr_logfile=/var/log/supervisor/fluxbox-error.log

[program:PaneDesktop]
command=/usr/bin/Pane --no-sandbox --start-fullscreen --pane-dir /home/${PANE_USER}/.pane
priority=40
autostart=false
autorestart=false
environment=DISPLAY=":99",HOME="/home/${PANE_USER}",XDG_RUNTIME_DIR="/run/user/${PANE_UID}"
user=${PANE_USER}
directory=/home/${PANE_USER}
stdout_logfile=/var/log/supervisor/Pane.log
stderr_logfile=/var/log/supervisor/pane-error.log
startsecs=5
startretries=5

[program:x11vnc]
command=/usr/bin/x11vnc -display :99 -passwd ${VNC_PASSWORD} -forever -rfbport 5900 -localhost -noxdamage -cursor arrow -noxfixes
priority=50
autorestart=true
user=${PANE_USER}
stdout_logfile=/var/log/supervisor/x11vnc.log
stderr_logfile=/var/log/supervisor/x11vnc-error.log

[program:websockify]
command=/usr/bin/websockify --web=/usr/share/novnc 6080 localhost:5900
priority=60
autorestart=true
stdout_logfile=/var/log/supervisor/websockify.log
stderr_logfile=/var/log/supervisor/websockify-error.log
SUPERVISOR_FALLBACK_EOF

  SUPERVISOR_GROUP_PROGRAMS="xvfb,pane-daemon,fluxbox,PaneDesktop,x11vnc,websockify"
fi

cat >> /etc/supervisor/conf.d/pane-stack.conf << SUPERVISOR_GROUP_EOF

[group:pane-cloud]
programs=${SUPERVISOR_GROUP_PROGRAMS}
priority=999
SUPERVISOR_GROUP_EOF

echo "  Done."

# ============================================================
# 10. Configure NGINX
# ============================================================
echo "[10/10] Configuring NGINX..."

cat > /etc/nginx/sites-available/pane-cloud << NGINX_EOF
# Pane Cloud - NGINX reverse proxy for the hosted workspace daemon
# noVNC stays optional and is only exposed when fallback is enabled.

server {
    listen 80 default_server;
    server_name _;

    location = /health {
        access_log off;
        proxy_pass http://127.0.0.1:${REMOTE_DAEMON_PORT}/health;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_buffering off;
    }

    location /daemon/ {
        proxy_pass http://127.0.0.1:${REMOTE_DAEMON_PORT}/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
NGINX_EOF

if [ "$ENABLE_NOVNC_FALLBACK" = "true" ]; then
  cat >> /etc/nginx/sites-available/pane-cloud << 'NGINX_FALLBACK_EOF'

    # noVNC static files
    location /novnc/ {
        alias /usr/share/novnc/;
        index vnc.html;
    }

    # WebSocket proxy to websockify
    location /websockify {
        proxy_pass http://127.0.0.1:6080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        proxy_buffering off;
    }

    location / {
        return 301 /novnc/vnc.html?autoconnect=true&resize=scale&reconnect=true&reconnect_delay=1000;
    }
}
NGINX_FALLBACK_EOF
else
  cat >> /etc/nginx/sites-available/pane-cloud << 'NGINX_DAEMON_ONLY_EOF'

    location / {
        access_log off;
        default_type text/plain;
        return 200 'Pane hosted daemon ready. Use /daemon/ through your authenticated tunnel.';
    }
}
NGINX_DAEMON_ONLY_EOF
fi

# Enable the site
ln -sf /etc/nginx/sites-available/pane-cloud /etc/nginx/sites-enabled/pane-cloud
rm -f /etc/nginx/sites-enabled/default

# Test NGINX config
nginx -t

echo "  Done."

# ============================================================
# Final setup
# ============================================================

# Create XDG runtime directory for Pane user
mkdir -p "/run/user/${PANE_UID}"
chown "${PANE_USER}:${PANE_USER}" "/run/user/${PANE_UID}"

# Enable and start services
systemctl enable supervisor
systemctl enable nginx
systemctl restart supervisor
systemctl restart nginx

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Hosted daemon loopback port: ${REMOTE_DAEMON_PORT}"
echo "Hosted daemon health endpoint: http://127.0.0.1/health"
echo "Hosted daemon reverse-proxy path: http://127.0.0.1/daemon/"
echo ""
echo "Access via IAP tunnel:"
echo "  gcloud compute start-iap-tunnel <INSTANCE> 80 --local-host-port=localhost:8080 --zone=<ZONE> --project=<PROJECT>"
echo "  Then connect your local Pane client to: http://127.0.0.1:8080/daemon/"
echo ""
if [ "$ENABLE_NOVNC_FALLBACK" = "true" ]; then
  echo "noVNC fallback is enabled."
  echo "  The desktop app is not auto-started so it does not compete with the headless daemon."
  echo "  To debug the desktop app:"
  echo "    sudo supervisorctl stop pane-cloud:pane-daemon"
  echo "    sudo supervisorctl start pane-cloud:PaneDesktop"
  echo "  VNC password: ${VNC_PASSWORD}"
  echo "  Browser URL: http://localhost:8080/novnc/vnc.html?autoconnect=true&resize=scale"
  echo ""
fi
echo "First-run auth (SSH in via IAP, or use the optional noVNC fallback if enabled):"
echo "  1. gh auth login     (GitHub)"
echo "  2. claude login      (Claude Code)"
echo "  3. Set API keys in Pane Settings"
echo ""
