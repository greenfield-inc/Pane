from __future__ import annotations

import json
import os
import re
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict

from .platforms import PanePlatform, arch_aliases, default_format, platform_param

GITHUB_API_BASE = "https://api.github.com/repos/greenfield-inc/Pane/releases"
DOWNLOAD_API_BASE = "https://runpane.com/api/download"


@dataclass
class ResolvedRelease:
    release: Dict[str, Any]
    artifact: Dict[str, Any]
    format: str
    preferred_download_url: str
    fallback_download_url: str
    checksum_url: str


def resolve_release(
    *,
    version: str,
    channel: str,
    source: str,
    platform: PanePlatform,
    format_name: str,
    target: str,
    fetch_timeout_seconds: float = 30,
) -> ResolvedRelease:
    release = fetch_release(version, timeout_seconds=fetch_timeout_seconds)
    selected_format = default_format(platform, target) if format_name == "auto" else format_name
    artifact = find_artifact(release, platform, selected_format)
    preferred = build_preferred_download_url(channel, source, platform, selected_format, release)
    tag_name = release["tag_name"]
    return ResolvedRelease(
        release=release,
        artifact=artifact,
        format=selected_format,
        preferred_download_url=preferred,
        fallback_download_url=artifact["browser_download_url"],
        checksum_url=f"https://github.com/greenfield-inc/Pane/releases/download/{tag_name}/SHA256SUMS.txt",
    )


def fetch_release(version: str, timeout_seconds: float = 30) -> Dict[str, Any]:
    normalized = "latest" if version == "latest" else f"tags/{version if version.startswith('v') else 'v' + version}"
    req = urllib.request.Request(
        f"{GITHUB_API_BASE}/{normalized}",
        headers={"Accept": "application/vnd.github+json", "User-Agent": "runpane-installer"},
    )
    with urllib.request.urlopen(req, timeout=timeout_seconds) as response:
        release = json.loads(response.read().decode("utf-8"))

    if release.get("draft") or release.get("prerelease"):
        raise RuntimeError(f"Release {release.get('tag_name')} is not a stable public release.")
    return release


def find_artifact(release: Dict[str, Any], platform: PanePlatform, format_name: str) -> Dict[str, Any]:
    assets = release.get("assets") or []
    candidates = [
        asset for asset in assets
        if matches_format(asset["name"], format_name) and matches_platform(asset["name"], platform)
    ]
    aliases = arch_aliases(platform)
    for asset in candidates:
        lower = asset["name"].lower()
        if any(alias.lower() in lower for alias in aliases):
            return asset
    for asset in candidates:
        if "universal" in asset["name"].lower():
            return asset
    if candidates:
        return candidates[0]
    names = ", ".join(asset["name"] for asset in assets) or "no assets"
    raise RuntimeError(f"No Pane {format_name} asset found for {platform.os}/{platform.arch}. Assets: {names}")


def artifact_file_name(url_or_name: str) -> str:
    return os.path.basename(url_or_name.split("?", 1)[0])


def build_preferred_download_url(
    channel: str,
    source: str,
    platform: PanePlatform,
    format_name: str,
    release: Dict[str, Any],
) -> str:
    query = urllib.parse.urlencode({
        "platform": platform_param(platform),
        "arch": platform.arch,
        "format": format_name,
        "version": release["tag_name"],
        "channel": channel,
        "source": source,
    })
    return f"{DOWNLOAD_API_BASE}?{query}"


def matches_format(name: str, format_name: str) -> bool:
    lower = name.lower()
    if format_name == "appimage":
        return lower.endswith(".appimage")
    return lower.endswith(f".{format_name}")


def matches_platform(name: str, platform: PanePlatform) -> bool:
    lower = name.lower()
    if platform.os == "darwin":
        return "macos" in lower or "darwin" in lower or "mac" in lower
    if platform.os == "win32":
        return "windows" in lower or re.search(r"(?:^|[._-])win(?:32|64)?(?:[._-]|$)", lower) is not None
    return "linux" in lower
