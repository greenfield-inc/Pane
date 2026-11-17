from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Mapping, Optional

from .platforms import PanePlatform, arch_aliases, default_format, platform_param

GITHUB_API_BASE = "https://api.github.com/repos/greenfield-inc/Pane/releases"
DOWNLOAD_API_BASE = "https://runpane.com/api/download"
# A cached lookup younger than this is used without asking GitHub again.
RELEASE_CACHE_FRESH_SECONDS = 60 * 60
# When GitHub can't be reached, a cached lookup younger than this stands in for it.
RELEASE_CACHE_FALLBACK_SECONDS = 24 * 60 * 60
RELEASE_CACHE_VERSION = 1


@dataclass
class ResolvedRelease:
    release: Dict[str, Any]
    artifact: Dict[str, Any]
    format: str
    preferred_download_url: str
    fallback_download_url: str
    checksum_url: str
    # Set when the lookup went through `cache_file`.
    lookup: Optional["ReleaseLookup"] = None


@dataclass
class ReleaseLookup:
    release: Dict[str, Any]
    # True when the release came from the cache file rather than from GitHub on this run.
    cached: bool
    # When GitHub returned this release, as an ISO timestamp.
    fetched_at: str
    # Set when GitHub failed on this run and an older cached lookup stands in for it.
    refresh_error: Optional[str] = None


def resolve_release(
    *,
    version: str,
    channel: str,
    source: str,
    platform: PanePlatform,
    format_name: str,
    target: str,
    fetch_timeout_seconds: float = 30,
    cache_file: Optional[str] = None,
    now: Optional[Callable[[], float]] = None,
) -> ResolvedRelease:
    lookup = (
        fetch_release_cached(version, cache_file=cache_file, timeout_seconds=fetch_timeout_seconds, now=now)
        if cache_file
        else None
    )
    release = lookup.release if lookup else fetch_release(version, timeout_seconds=fetch_timeout_seconds)
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
        lookup=lookup,
    )


def fetch_release(version: str, timeout_seconds: float = 30) -> Dict[str, Any]:
    normalized = "latest" if version == "latest" else f"tags/{version if version.startswith('v') else 'v' + version}"
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "runpane-installer"}
    headers.update(github_auth_headers())
    req = urllib.request.Request(f"{GITHUB_API_BASE}/{normalized}", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout_seconds) as response:
            release = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        # Same wording as the npm CLI, so `doctor --json` matches.
        raise RuntimeError(f"Failed to fetch Pane release {version}: {error.code} {error.reason or ''}".rstrip()) from None

    if release.get("draft") or release.get("prerelease"):
        raise RuntimeError(f"Release {release.get('tag_name')} is not a stable public release.")
    return release


def github_token(env: Optional[Mapping[str, str]] = None) -> Optional[str]:
    """The GitHub token from GH_TOKEN, else GITHUB_TOKEN, so API calls count against the person's
    5,000 an hour instead of the 60 an hour GitHub gives each unauthenticated address. Never printed."""
    source = os.environ if env is None else env
    for name in ("GH_TOKEN", "GITHUB_TOKEN"):
        value = (source.get(name) or "").strip()
        if value:
            return value
    return None


def github_auth_headers() -> Dict[str, str]:
    token = github_token()
    return {"Authorization": f"Bearer {token}"} if token else {}


def fetch_release_cached(
    version: str,
    *,
    cache_file: str,
    timeout_seconds: float = 30,
    now: Optional[Callable[[], float]] = None,
) -> ReleaseLookup:
    """fetch_release behind a small on-disk cache, like the npm CLI's fetchReleaseCached. A lookup
    younger than RELEASE_CACHE_FRESH_SECONDS is reused without a request. Otherwise GitHub is asked;
    a good answer replaces the cached one, and a failure falls back to a cached lookup younger than
    RELEASE_CACHE_FALLBACK_SECONDS (with refresh_error set), or raises when there is none. Reading or
    writing the cache never fails the lookup."""
    clock = now or time.time
    entry = read_release_cache_entry(cache_file, version)
    age = clock() - parse_iso_timestamp(entry["fetchedAt"]) if entry else None
    if entry and age is not None and 0 <= age < RELEASE_CACHE_FRESH_SECONDS:
        return ReleaseLookup(release=entry["release"], cached=True, fetched_at=entry["fetchedAt"])
    try:
        release = fetch_release(version, timeout_seconds=timeout_seconds)
    except Exception as error:
        if entry and age is not None and 0 <= age < RELEASE_CACHE_FALLBACK_SECONDS:
            return ReleaseLookup(
                release=entry["release"],
                cached=True,
                fetched_at=entry["fetchedAt"],
                refresh_error=str(error),
            )
        raise
    fetched_at = iso_timestamp(clock())
    write_release_cache_entry(cache_file, version, {"fetchedAt": fetched_at, "release": cacheable_release(release)})
    return ReleaseLookup(release=release, cached=False, fetched_at=fetched_at)


def iso_timestamp(seconds: float) -> str:
    """The same form as JavaScript's Date.toISOString: UTC with milliseconds and a Z."""
    moment = datetime.fromtimestamp(seconds, tz=timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def parse_iso_timestamp(value: Any) -> Optional[float]:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def cacheable_release(release: Dict[str, Any]) -> Dict[str, Any]:
    """The fields the npm CLI keeps, so both CLIs read and write the same cache file."""
    kept = {key: release.get(key) for key in ("tag_name", "name", "body", "html_url", "published_at", "prerelease", "draft")}
    if isinstance(release.get("assets"), list):
        kept["assets"] = [
            {"name": asset.get("name"), "browser_download_url": asset.get("browser_download_url")}
            for asset in release["assets"]
            if isinstance(asset, dict)
        ]
    return kept


def valid_cache_entry(entry: Any) -> bool:
    if not isinstance(entry, dict) or parse_iso_timestamp(entry.get("fetchedAt")) is None:
        return False
    release = entry.get("release")
    if not isinstance(release, dict):
        return False
    strings = ("tag_name", "name", "body", "html_url", "published_at")
    if not all(isinstance(release.get(key), str) for key in strings):
        return False
    if not all(isinstance(release.get(key), bool) for key in ("prerelease", "draft")):
        return False
    assets = release.get("assets")
    if assets is None:
        return True
    return isinstance(assets, list) and all(
        isinstance(asset, dict) and isinstance(asset.get("name"), str) and isinstance(asset.get("browser_download_url"), str)
        for asset in assets
    )


def read_release_cache_file(cache_file: str) -> Optional[Dict[str, Any]]:
    try:
        with open(cache_file, "r", encoding="utf-8") as handle:
            parsed = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(parsed, dict) or parsed.get("version") != RELEASE_CACHE_VERSION or not isinstance(parsed.get("entries"), dict):
        return None
    # A malformed entry is a cache miss for that version only.
    entries = {key: value for key, value in parsed["entries"].items() if valid_cache_entry(value)}
    return {"version": RELEASE_CACHE_VERSION, "entries": entries}


def read_release_cache_entry(cache_file: str, version: str) -> Optional[Dict[str, Any]]:
    cache = read_release_cache_file(cache_file)
    return cache["entries"].get(version) if cache else None


def write_release_cache_entry(cache_file: str, version: str, entry: Dict[str, Any]) -> None:
    cache = read_release_cache_file(cache_file) or {"version": RELEASE_CACHE_VERSION, "entries": {}}
    cache["entries"][version] = entry
    partial = f"{cache_file}.{os.getpid()}.partial"
    try:
        os.makedirs(os.path.dirname(cache_file), exist_ok=True)
        with open(partial, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(cache, indent=2) + "\n")
        os.replace(partial, cache_file)
    except OSError:
        # The cache only saves requests; a read-only Pane directory just means the next run asks GitHub again.
        try:
            os.remove(partial)
        except OSError:
            pass


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
