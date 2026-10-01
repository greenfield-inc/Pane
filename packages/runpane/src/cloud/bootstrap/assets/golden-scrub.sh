#!/bin/bash
# golden-scrub.sh — identity scrub for a Runpane Cloud golden image. Run as root (sudo) right before
# `POST /named-snapshots`, and by rp-bootstrap.sh `identity` on every new cloud sandbox (forks skip boot units).
# Source of truth: packages/runpane/src/cloud/bootstrap/assets. Idempotent. Removes per-user/per-machine identity and installs a first-boot
# unit that regenerates /etc/machine-id + SSH host keys on every fork/sandbox created from the image.
# Env: U=<login user> (default: user).  Usage: sudo U=user bash golden-scrub.sh
set -u
U="${U:-user}"; H=$(getent passwd "$U" | cut -d: -f6); H="${H:-/home/$U}"
log(){ echo "scrub: $*"; }
rmx(){ for p in "$@"; do if [ -e "$p" ] || [ -L "$p" ]; then rm -rf --one-file-system -- "$p" && log "removed $p"; fi; done; }

# 1. stop identity-bearing services so they don't rewrite state after we delete it
systemctl stop tailscaled 2>/dev/null
sudo -u "$U" XDG_RUNTIME_DIR=/run/user/$(id -u "$U") systemctl --user stop pane-remote-daemon.service 2>/dev/null
pkill -u "$U" -f '/opt/Pane/pane' 2>/dev/null; true

# 2. agent / tool credentials (every home incl. root)
for h in "$H" /root; do
  rmx "$h/.claude/.credentials.json" "$h/.claude.json.backup" \
      "$h/.config/gh/hosts.yml" \
      "$h/.git-credentials" "$h/.config/git/credentials" \
      "$h/.npmrc" "$h/.yarnrc" "$h/.yarnrc.yml.auth" \
      "$h/.docker/config.json" \
      "$h/.config/google-chrome" "$h/.config/chromium" "$h/.cache/google-chrome" "$h/.cache/chromium" \
      "$h/.bash_history" "$h/.zsh_history" "$h/.python_history" "$h/.node_repl_history" "$h/.lesshst" "$h/.viminfo" \
      "$h/.local/share/fish/fish_history" \
      "$h/.ssh/id_"* "$h/.ssh/known_hosts" "$h/.ssh/known_hosts.old" \
      "$h/.pane_remote" "$h/.pane/config.json" \
      "$h/.runpane-cloud/pairing.code" "$h/.runpane-cloud/client-"*.code "$h/.runpane-cloud/session-id" \
      "$h/.codex/auth.json" "$h/.config/opencode/auth.json" "$h/.local/share/opencode/auth.json"
  # credential helpers configured in gitconfig carry no secret, but store= paths do; drop the helper line
  [ -f "$h/.gitconfig" ] && git config --file "$h/.gitconfig" --unset-all credential.helper 2>/dev/null
done
# ~/.pane_remote/config.json: `runpane install daemon` (even --no-install-service) writes remoteDaemon.host.clients[]
# with a pre-provisioned client {id,label,tokenHash} (= the pairing code), access.baseUrl/tunnel, mobilePush registrations.
# The whole dir is per-sandbox state (sessions.db, logs) -> drop it; per-sandbox provisioning re-runs setup after fork.
# ~/.pane/config.json holds the per-install analytics id. The Pane .deb (/opt/Pane) stays in the image.
# Playwright's own Chromium keeps no profile in the image (profiles are temp dirs); nothing to strip there.

# 3. machine identity
rmx /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub
: > /etc/machine-id; rmx /var/lib/dbus/machine-id   # empty (not missing): systemd treats it as "first boot"
rmx /var/lib/systemd/random-seed /var/lib/systemd/credential.secret

# 4. tailscale node identity (machine key, node key, prefs, login profile)
rmx /var/lib/tailscale/tailscaled.state /var/lib/tailscale/files /var/lib/tailscale/derpmap.cached.json \
    /var/lib/tailscale/tailscaled.log*.txt /var/lib/tailscale/.config
# ...and bootstrap's in-place backup of it, or rp-tailscale-state-restore would bring the old node back
rmx /var/lib/rp-ts-backup/tailscaled.state
# keep tailscaled enabled; with no state it comes up NeedsLogin and generates a fresh machine key

# 5. logs and histories that may echo identifiers / tokens
journalctl --rotate >/dev/null 2>&1; journalctl --vacuum-time=1s >/dev/null 2>&1
rmx /root/.bash_history /var/log/auth.log /var/log/wtmp.1 /var/log/lastlog
: > /var/log/wtmp 2>/dev/null; : > /var/log/btmp 2>/dev/null
rmx "$H/rc/private"

# 6. first-boot regeneration unit (runs before sshd/tailscaled on every boot, acts only when needed)
cat > /usr/local/sbin/rp-firstboot-identity <<'SH'
#!/bin/sh
# regenerate per-machine identity if the golden scrub left it empty
if [ ! -s /etc/machine-id ] || [ "$(cat /etc/machine-id)" = uninitialized ]; then
  rm -f /etc/machine-id /var/lib/dbus/machine-id
  systemd-machine-id-setup && ln -sf /etc/machine-id /var/lib/dbus/machine-id
  echo "rp-firstboot: new machine-id"
fi
if ! ls /etc/ssh/ssh_host_*_key >/dev/null 2>&1; then ssh-keygen -A && echo "rp-firstboot: new ssh host keys"; fi
SH
chmod 755 /usr/local/sbin/rp-firstboot-identity
cat > /etc/systemd/system/rp-firstboot-identity.service <<'UNIT'
[Unit]
Description=Runpane: regenerate machine-id and SSH host keys on first boot of a fork
DefaultDependencies=no
After=local-fs.target
Before=ssh.service sshd.service tailscaled.service pane-remote-daemon.service sysinit.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/rp-firstboot-identity
[Install]
WantedBy=sysinit.target
UNIT
systemctl daemon-reload; systemctl enable rp-firstboot-identity.service 2>&1 | sed 's/^/scrub: /'
sync; log "done $(date -u +%FT%TZ)"
