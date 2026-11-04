"""Delegate to Pane's durable update engine, preserving the invoked pip owner."""
from __future__ import annotations

import os
from pathlib import Path
import json
import shutil
import subprocess
import sys
import time

from .daemon_client import PaneDaemonClientError, invoke_daemon, resolve_pane_directory


def run_update(parsed) -> int:
    pane_dir = Path(resolve_pane_directory(parsed.pane_dir)).resolve()
    engine = pane_dir / "bin" / "runpane.cjs"
    node = shutil.which("node")
    if not engine.is_file() or not node:
        refusal = PaneDaemonClientError(
            "The independent updater requires Pane's managed update engine and standalone Node. Nothing was changed.",
            code="ERR_UPDATE_RUNTIME",
            next="Open a Pane build supporting independent updates and install standalone Node, then retry from this Python environment.",
        )
        if parsed.update_status or parsed.dry_run or parsed.update_scope == "cli" or parsed.pane_version != "latest" or parsed.pane_path:
            raise refusal
        assert_update_options(parsed)
        return update_in_app(parsed, pane_dir, refusal)
    args = [node, str(engine), "update", "--pane-dir", str(pane_dir), "--version", parsed.pane_version]
    if parsed.update_scope != "both":
        args.append("--" + parsed.update_scope + "-only")
    if parsed.update_status:
        args.extend(["--status", parsed.update_status])
    for enabled, flag in [(parsed.update_wait, "--wait"), (parsed.json, "--json"), (parsed.dry_run, "--dry-run"), (parsed.yes, "--yes")]:
        if enabled:
            args.append(flag)
    args.extend(["--format", parsed.format])
    if parsed.download_dir:
        args.extend(["--download-dir", parsed.download_dir])
    if parsed.pane_path:
        args.extend(["--pane-path", parsed.pane_path])
    environment = dict(os.environ)
    environment.pop("ELECTRON_RUN_AS_NODE", None)
    environment["PANE_UPDATE_PYTHON"] = sys.executable
    environment["PANE_UPDATE_PYTHON_ENTRYPOINT"] = str(Path(__file__).with_name("cli.py"))
    return subprocess.call(args, env=environment)


NATIVE_UPDATE_FORMAT = {"darwin": "zip", "win32": "exe"}.get(sys.platform, "appimage")
RELAUNCH_TIMEOUT_SECONDS = 10 * 60


def assert_update_options(parsed) -> None:
    """The managed engine refuses these before updating; refuse them here too before handing off."""
    if parsed.channel != "stable" or parsed.download_dir or parsed.format not in {"auto", NATIVE_UPDATE_FORMAT}:
        raise PaneDaemonClientError(
            "These installer options are not supported by independent updates. Nothing was changed.",
            code="ERR_UPDATE_PREFLIGHT",
            next="Use the stable client release with automatic format and operation-owned staging, or use runpane install for other installer options.",
        )


def wait_for_relaunch(pane_dir: Path, version: str) -> None:
    """--wait: return once the relaunched Pane answers with the new version."""
    deadline = time.monotonic() + RELAUNCH_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        try:
            if invoke_daemon("runpane:update:host", [], pane_dir=str(pane_dir), timeout_ms=5_000).get("version") == version:
                return
        except PaneDaemonClientError:
            pass  # Pane is quitting, installing or starting
        time.sleep(2)
    raise PaneDaemonClientError(
        f"Timed out after 10 minutes waiting for Pane to come back as {version} from its built-in update. The install may still be running, or it may have failed and left the previous version.",
        code="ERR_UPDATE_IN_APP_TIMEOUT",
        next="Open Pane and check its version in Settings, then run runpane doctor --json.",
    )


def update_in_app(parsed, pane_dir: Path, refusal: PaneDaemonClientError) -> int:
    """Without the engine or Node, the running Pane installs the release itself with electron-updater."""
    try:
        result = invoke_daemon("runpane:update:in-app", [], pane_dir=str(pane_dir), timeout_ms=15 * 60_000)
    except PaneDaemonClientError as error:
        if error.code == "ERR_RUNPANE_DAEMON_CONNECT_FAILED":
            raise
        if error.code != "ERR_UNKNOWN_CHANNEL":
            raise PaneDaemonClientError(
                f"{error} The independent update had already refused this host: {refusal}",
                code=error.code,
                next=error.next,
            ) from error
        raise PaneDaemonClientError(
            f"Updating from runpane is unsupported by this Pane: it is older than the in-app update handoff, and the independent update refused this host ({refusal}).",
            code="ERR_UPDATE_IN_APP_UNAVAILABLE",
            next="Open Pane, go to Settings, and click Update. Then runpane update works directly next time.",
        ) from error
    phase = result["state"]
    if phase == "installing" and parsed.update_wait:
        wait_for_relaunch(pane_dir, result["version"])
        phase = "complete"
    next_step = {
        "installing": f"Pane {result['version']} installs and relaunches in about a minute; run runpane doctor --json afterwards to confirm.",
        "complete": f"Pane {result['version']} is running.",
    }.get(phase, f"Pane {result['version']} is the latest release.")
    if parsed.update_scope != "pane":
        next_step += " This CLI was not updated; update it with pip install --upgrade runpane."
    if parsed.json:
        print(json.dumps({
            "mode": "in-app",
            "phase": phase,
            "fromVersion": result["fromVersion"],
            "version": result["version"],
            "cliUpdated": False,
            "independentRefusal": {"code": refusal.code, "message": str(refusal)},
            "next": next_step,
        }, indent=2))
    else:
        print(f"The independent update cannot run here ({refusal}), so Pane's built-in updater is handling it.")
        headline = "Pane is up to date." if phase == "current" else f"Pane is updating itself from {result['fromVersion']} to {result['version']}."
        print(f"{headline} {next_step}")
    return 0
