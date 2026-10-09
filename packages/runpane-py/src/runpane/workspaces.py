"""The workspaces block that help, doctor, and agent-context print (mirrors the npm wrapper)."""
import json
import os
import subprocess
import sys
from typing import Any, Dict, List, Optional

from .daemon_client import invoke_daemon

REACH_LINE = "Reach them: runpane workspace <machine> read|write|exec|<command>"
OS_NAMES = {"macos": "macOS", "windows": "Windows", "linux": "Linux"}


def read_workspace_summary(pane_dir: Optional[str] = None) -> Dict[str, Any]:
    tailnet = read_tailnet()
    local = read_local_status(pane_dir)
    if not tailnet["ok"]:
        return {
            "state": "off", "machine": None, "reason": tailnet["reason"], "fix": tailnet["fix"], "otherMachines": [],
            "lines": [f"Workspaces: off ({tailnet['reason']}). Fix: {tailnet['fix']}"],
        }
    self_machine = tailnet["self"]
    machines = tailnet["machines"]
    state = local["state"] if local else "off"
    reason = local.get("reason") if local else "Pane is not running"
    fix = local.get("fix") if local else "Open Pane."
    described = ", ".join(f"{m['name']} ({m['os']}, {'online' if m['online'] else 'offline'})" for m in machines)
    lines = [
        f"Workspaces: on ({self_machine['name']})" if state == "on"
        else f"Workspaces: off on {self_machine['name']} ({reason}). Fix: {fix}",
        f"Other machines: {described or 'none'}",
    ]
    if machines:
        lines.append(REACH_LINE)
    summary: Dict[str, Any] = {
        "state": state,
        "machine": self_machine["name"],
        "otherMachines": [{"name": m["name"], "os": m["os"], "online": m["online"]} for m in machines],
        "lines": lines,
    }
    if state != "on":
        summary["reason"] = reason
        summary["fix"] = fix
    return summary


def read_tailnet() -> Dict[str, Any]:
    output = run_tailscale(["status", "--json"])
    if output is None:
        return {"ok": False, "reason": "Tailscale is not installed", "fix": "Install Tailscale from https://tailscale.com/download and sign in."}
    try:
        status = json.loads(output)
    except ValueError:
        return {"ok": False, "reason": "Tailscale status could not be read", "fix": "Update Tailscale."}
    peer_self = status.get("Self")
    if status.get("BackendState") != "Running" or not peer_self:
        return {"ok": False, "reason": "Tailscale is signed out", "fix": "Open Tailscale and sign in."}
    me = to_machine(peer_self, True)
    if me is None:
        return {"ok": False, "reason": f"Tailscale reports an unsupported OS ({peer_self.get('OS')})", "fix": "Run Pane on macOS, Windows, or Linux."}
    machines: List[Dict[str, Any]] = []
    for peer in (status.get("Peer") or {}).values():
        if peer.get("UserID") != peer_self.get("UserID") or peer.get("Tags"):
            continue
        machine = to_machine(peer, False)
        if machine:
            machines.append(machine)
    machines.sort(key=lambda m: (not m["online"], m["name"]))
    return {"ok": True, "self": me, "machines": machines}


def to_machine(peer: Dict[str, Any], is_self: bool) -> Optional[Dict[str, Any]]:
    os_name = OS_NAMES.get(str(peer.get("OS", "")).lower())
    if not os_name:
        return None
    dns_name = str(peer.get("DNSName", "")).rstrip(".")
    return {"name": dns_name.split(".")[0], "os": os_name, "online": is_self or peer.get("Online") is True}


def run_tailscale(args: List[str]) -> Optional[str]:
    candidates = [("tailscale", None)]
    if sys.platform == "darwin":
        for app in ["/Applications/Tailscale.app", os.path.join(os.path.expanduser("~"), "Applications", "Tailscale.app")]:
            candidates.append((os.path.join(app, "Contents", "MacOS", "Tailscale"), {**os.environ, "TAILSCALE_BE_CLI": "1"}))
    if sys.platform == "win32":
        for directory in [os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)"), os.environ.get("LOCALAPPDATA")]:
            if directory:
                candidates.append((os.path.join(directory, "Tailscale", "tailscale.exe"), None))
    for command, env in candidates:
        try:
            result = subprocess.run([command, *args], capture_output=True, text=True, timeout=3, env=env)
        except (OSError, subprocess.SubprocessError):
            continue
        if result.returncode == 0 or result.stdout:
            return result.stdout
    return None


def read_local_status(pane_dir: Optional[str]) -> Optional[Dict[str, Any]]:
    try:
        return invoke_daemon("runpane:workspaces:status", [], pane_dir=pane_dir, timeout_ms=1500)
    except Exception as error:  # noqa: BLE001 - any failure means Pane is not answering
        if "No Pane daemon command registered" in str(error):
            return {"enabled": False, "state": "off", "reason": "this Pane is older than workspaces", "fix": "Update Pane, then restart it."}
        return None
