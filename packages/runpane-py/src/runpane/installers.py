from __future__ import annotations

import os
import platform
import shutil
import subprocess
from dataclasses import dataclass
from typing import List, Optional

from .download import DownloadedArtifact
from .platforms import PanePlatform, default_install_root


@dataclass
class InstalledPane:
    executable_path: str
    install_kind: str


def resolve_existing_pane_path(pane_path: Optional[str] = None) -> Optional[str]:
    if pane_path:
        return pane_path if os.path.exists(pane_path) else None

    home = os.path.expanduser("~")
    candidates = []
    if os.name == "nt":
        local = os.environ.get("LOCALAPPDATA")
        program_files = os.environ.get("ProgramFiles")
        if local:
            candidates.extend([
                os.path.join(local, "Programs", "Pane", "Pane.exe"),
                os.path.join(local, "Pane", "Pane.exe"),
            ])
        if program_files:
            candidates.append(os.path.join(program_files, "Pane", "Pane.exe"))
    elif platform.system().lower() == "darwin":
        candidates.extend([
            "/Applications/Pane.app/Contents/MacOS/Pane",
            os.path.join(home, "Applications", "Pane.app", "Contents", "MacOS", "Pane"),
        ])
    else:
        candidates.extend([
            os.path.join(home, ".local", "bin", "pane"),
            "/usr/bin/pane",
            "/opt/Pane/pane",
            "/opt/Pane/Pane",
        ])

    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate
    return None


def should_reuse_existing_pane(parsed, target: str) -> bool:
    return parsed.command == "install" and target == "daemon"


def install_pane_artifact(
    artifact: DownloadedArtifact,
    parsed,
    platform: PanePlatform,
    format_name: str,
    target: str,
) -> InstalledPane:
    existing = resolve_existing_pane_path(parsed.pane_path)
    if existing and should_reuse_existing_pane(parsed, target):
        return InstalledPane(executable_path=existing, install_kind="existing")

    if platform.os == "darwin":
        return install_mac(artifact, format_name, target)
    if platform.os == "linux":
        return install_linux(artifact, format_name)
    return install_windows(artifact, target)


def spawn_pane(executable_path: str, args: List[str]) -> int:
    try:
        return subprocess.call(
            [executable_path, *build_pane_daemon_args(args)],
            env=build_pane_daemon_environment(),
        )
    except OSError as error:
        print(f"Failed to launch Pane: {error}")
        return 1


def spawn_pane_captured(executable_path: str, args: List[str]):
    try:
        return subprocess.run(
            [executable_path, *build_pane_daemon_args(args)],
            env=build_pane_daemon_environment(),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except OSError as error:
        return subprocess.CompletedProcess([executable_path, *args], 1, "", str(error))


def build_pane_daemon_args(args: List[str], system_name: Optional[str] = None) -> List[str]:
    """Ozone resolves its platform before the app's main script runs, so headless
    selection must arrive as argv. ELECTRON_OZONE_PLATFORM_HINT (below) was removed
    in Electron 38 and is a no-op from 39 on; it is kept only so older Pane builds
    keep working."""
    if (system_name or platform.system()).lower() != "linux":
        return list(args)
    return ["--ozone-platform=headless", "--disable-gpu", *args]


def build_pane_daemon_environment(
    system_name: Optional[str] = None,
    base_environment: Optional[dict] = None,
) -> dict:
    environment = dict(os.environ if base_environment is None else base_environment)
    if (system_name or platform.system()).lower() == "linux":
        environment["ELECTRON_OZONE_PLATFORM_HINT"] = "headless"
    return environment


def launch_pane_client(executable_path: str) -> None:
    subprocess.Popen([executable_path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def install_mac(artifact: DownloadedArtifact, format_name: str, target: str) -> InstalledPane:
    if format_name == "dmg":
        subprocess.call(["open", artifact.path])
        return InstalledPane(executable_path="/Applications/Pane.app/Contents/MacOS/Pane", install_kind="launched-installer")

    apps_root = os.path.join(os.path.expanduser("~"), "Applications")
    app_path = os.path.join(apps_root, "Pane.app")
    os.makedirs(apps_root, exist_ok=True)
    subprocess.check_call(["ditto", "-x", "-k", artifact.path, apps_root])
    executable_path = os.path.join(app_path, "Contents", "MacOS", "Pane")
    if not os.path.exists(executable_path):
        raise RuntimeError(f"Pane executable was not found after extracting {artifact.file_name}. Expected {executable_path}")
    if target == "client":
        subprocess.call(["open", app_path])
    return InstalledPane(executable_path=executable_path, install_kind="installed")


def install_linux(artifact: DownloadedArtifact, format_name: str) -> InstalledPane:
    if format_name == "deb":
        installer = "apt" if shutil.which("apt") else "dpkg"
        args = ["install", "-y", artifact.path] if installer == "apt" else ["-i", artifact.path]
        status = subprocess.call(["sudo", installer, *args])
        if status != 0:
            raise RuntimeError(f"Pane installer exited with status {status}.")
        executable = resolve_existing_pane_path()
        if not executable:
            raise RuntimeError("Pane installed from .deb, but the pane executable could not be found.")
        return InstalledPane(executable_path=executable, install_kind="installed")

    bin_root = default_install_root()
    os.makedirs(bin_root, exist_ok=True)
    executable_path = os.path.join(bin_root, "pane")
    shutil.copyfile(artifact.path, executable_path)
    os.chmod(executable_path, 0o755)
    return InstalledPane(executable_path=executable_path, install_kind="installed")


def install_windows(artifact: DownloadedArtifact, target: str) -> InstalledPane:
    args = ["/S"] if target == "daemon" else []
    status = subprocess.call([artifact.path, *args])
    if status != 0:
        raise RuntimeError(f"Pane installer exited with status {status}.")
    executable = resolve_existing_pane_path()
    if not executable:
        raise RuntimeError("Pane installer completed, but Pane.exe could not be found. Open the installer manually and rerun with --pane-path.")
    return InstalledPane(executable_path=executable, install_kind="installed" if target == "daemon" else "launched-installer")
