"""`runpane machine health|cleanup`: read this machine's health and free the disk space Pane made.

Pane's cleanup engine decides what is safe to delete; this module shapes requests and output.
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from typing import Any, Dict, List

from .daemon_client import invoke_daemon
from .generated_contract import RUNPANE_CONTRACT
from .notify import RunpaneError

SNAPSHOT_CHANNEL = "resource-monitor:machine-health"
INVENTORY_CHANNEL = "resource-monitor:machine-inventory"
CLEANUP_CHANNEL = "resource-monitor:machine-cleanup"
RECLAIM_KINDS: List[str] = list(RUNPANE_CONTRACT["enums"]["reclaimKinds"])
FOREIGN_KINDS = set(RUNPANE_CONTRACT["enums"]["foreignReclaimKinds"])
TOP_PANES = 5
# The fields the --json output carries, as the npm CLI decodes them, so both print the same JSON.
ITEM_FIELDS = ("id", "kind", "tier", "path", "sizeBytes", "modifiedAt", "sessionId", "reason", "projectPath", "howToFree")
RUN_FIELDS = ("at", "source", "removed", "skipped", "freedBytes")
ENTRY_FIELDS = ("id", "kind", "path", "sizeBytes", "reason")
TIER_TITLES = {
    1: "Tier 1, Pane removes these by itself",
    2: "Tier 2, Pane asks first",
    3: "Tier 3, not Pane's to delete",
}


def run_machine_health(parsed: Any) -> int:
    snapshot = invoke_daemon(SNAPSHOT_CHANNEL, [], pane_dir=parsed.pane_dir)
    inventory = invoke_daemon(INVENTORY_CHANNEL, [{"refresh": False}], pane_dir=parsed.pane_dir)
    if parsed.json:
        print_json({"ok": True, "snapshot": snapshot, "inventory": inventory})
        return 0
    for line in health_lines(snapshot, inventory):
        print(line)
    return 0


def run_machine_cleanup(parsed: Any) -> int:
    kind = require_kind(parsed.kind)
    if kind in FOREIGN_KINDS or not parsed.yes:
        inventory = invoke_daemon(INVENTORY_CHANNEL, [{"refresh": False}], pane_dir=parsed.pane_dir)
        of_kind = [item for item in inventory.get("items") or [] if item.get("kind") == kind]
        if kind in FOREIGN_KINDS:
            raise not_panes_error(kind, of_kind)
        items = [item for item in of_kind if item.get("tier") != 3]
        total_bytes = sum(item["sizeBytes"] for item in items)
        if parsed.json:
            print_json({"ok": True, "dryRun": True, "kind": kind, "items": [pick(item, ITEM_FIELDS) for item in items], "totalBytes": total_bytes})
            return 0
        if not items:
            print(f"No {kind} items to delete in the last scan ({iso_time(inventory['scannedAt'])}).")
            return 0
        print(f"{count(len(items), f'{kind} item')}, {format_bytes(total_bytes)}:")
        for item in items:
            print(f"  {format_bytes(item['sizeBytes'])}  {item['path']}: {item['reason']}")
        print("Dry run: nothing was deleted. With --yes, Pane checks each item again and deletes those not in use or protected.")
        return 0

    run = invoke_daemon(CLEANUP_CHANNEL, [{"kinds": [kind], "source": "cli"}], pane_dir=parsed.pane_dir)
    if parsed.json:
        result = pick(run, RUN_FIELDS)
        result["removed"] = [pick(entry, ENTRY_FIELDS) for entry in run.get("removed") or []]
        result["skipped"] = [pick(entry, ENTRY_FIELDS) for entry in run.get("skipped") or []]
        print_json({"ok": True, "dryRun": False, "kind": kind, "run": result})
        return 0
    removed = run.get("removed") or []
    skipped = run.get("skipped") or []
    if not removed and not skipped:
        print(f"Removed nothing: no {kind} items were left to delete.")
        return 0
    print(f"Removed {count(len(removed), f'{kind} item')}, freed {format_bytes(run['freedBytes'])}.")
    for entry in removed:
        print(f"  {format_bytes(entry['sizeBytes'])}  {entry['path']}")
    if skipped:
        print(f"Skipped {count(len(skipped), 'item')}:")
        for entry in skipped:
            print(f"  {format_bytes(entry['sizeBytes'])}  {entry['path']}: {entry.get('reason') or 'skipped'}")
    return 0


def require_kind(kind: Any) -> str:
    valid = f"Valid kinds: {', '.join(RECLAIM_KINDS)}."
    next_step = "Run runpane machine health to see each item's kind."
    if not kind:
        raise RunpaneError("ERR_RUNPANE_INVALID_ARGUMENT", f"runpane machine cleanup requires --kind <kind>. {valid} Nothing was deleted.", next_step)
    if kind not in RECLAIM_KINDS:
        raise RunpaneError("ERR_RUNPANE_INVALID_ARGUMENT", f'Unknown --kind "{kind}". {valid} Nothing was deleted.', next_step)
    return kind


def not_panes_error(kind: str, items: List[Dict[str, Any]]) -> RunpaneError:
    reason = f" {items[0]['reason']}" if items else ""
    how_tos: List[str] = []
    for item in items:
        how = item.get("howToFree")
        if how and how not in how_tos:
            how_tos.append(how)
    if not how_tos:
        next_step = "Free it with the tool that owns it; runpane machine health shows each item and its owner."
    elif len(how_tos) == 1:
        next_step = f"Free it with the tool that owns it: {how_tos[0]}"
    else:
        next_step = f"Free each with the tool that owns it, for example: {how_tos[0]}. runpane machine health lists how to free each one."
    return RunpaneError("ERR_MACHINE_CLEANUP_NOT_PANES", f"{kind} is tier 3: not Pane's to delete.{reason} Nothing was deleted.", next_step)


def health_lines(snapshot: Dict[str, Any], inventory: Dict[str, Any]) -> List[str]:
    lines = [f"Machine health for {snapshot['hostname']}, sampled {iso_time(snapshot['sampledAt'])}"]
    disk = snapshot["disk"]
    lines.append(f"Disk: {disk['level']}")
    for volume in disk["volumes"]:
        lines.append(
            f"  {volume['path']} ({', '.join(volume['roles'])}): {format_bytes(volume['freeBytes'])} free of {format_bytes(volume['totalBytes'])}, {volume['level']}"
        )
    memory = snapshot["memory"]
    lines.append(f"Memory: {memory['level']} ({memory['source']}): {memory['detail']}")
    lines.append("Top Panes by memory:")
    panes = sorted(snapshot["panes"], key=lambda pane: -pane["rssMB"])[:TOP_PANES]
    for pane in panes:
        lines.append(
            f"  {pane['name']}: {format_bytes(pane['rssMB'] * 1024 * 1024)}, {one_decimal(pane['cpuPercent'])}% CPU, {count(len(pane['processes']), 'process', 'processes')}"
        )
    if not panes:
        lines.append("  None.")
    lines.append("Leak warnings:")
    names = {pane["sessionId"]: pane["name"] for pane in snapshot["panes"]}
    for leak in snapshot["leaks"]:
        pane_name = names.get(leak["sessionId"], leak["sessionId"])
        minutes = math.floor(leak["windowMs"] / 60_000 + 0.5)
        lines.append(
            f"  {leak['name']} (pid {leak['pid']}) in {pane_name}: {format_bytes(leak['memoryMB'] * 1024 * 1024)}, grew {format_bytes(leak['growthMB'] * 1024 * 1024)} in {minutes} min"
        )
    if not snapshot["leaks"]:
        lines.append("  None.")
    lines.append(f"Storage, scanned {iso_time(inventory['scannedAt'])}:")
    for tier in (1, 2, 3):
        items = [item for item in inventory["items"] if item["tier"] == tier]
        lines.append(f"{TIER_TITLES[tier]} ({format_bytes(sum(item['sizeBytes'] for item in items))}):")
        for item in items:
            lines.append(f"  {item['kind']}  {format_bytes(item['sizeBytes'])}  {item['path']}: {item['reason']}")
            if item.get("howToFree"):
                lines.append(f"    Free it: {item['howToFree']}")
        if not items:
            lines.append("  None.")
    lines.append("Free tier 1 and 2 items with runpane machine cleanup --kind <kind>; it is a dry run until you add --yes.")
    return lines


def one_decimal(value: float) -> str:
    """One decimal, halves rounded up, so the npm and Python CLIs print the same digits."""
    return f"{math.floor(value * 10 + 0.5) / 10:.1f}"


def format_bytes(size: float) -> str:
    if size < 1024:
        return f"{math.floor(size + 0.5)} B"
    units = ["KB", "MB", "GB", "TB"]
    value = size / 1024
    unit = 0
    while value >= 1024 and unit < len(units) - 1:
        value /= 1024
        unit += 1
    return f"{one_decimal(value)} {units[unit]}"


def count(n: int, one: str, many: str = "") -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


def iso_time(ms: float) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def pick(value: Dict[str, Any], fields: tuple) -> Dict[str, Any]:
    return {field: value[field] for field in fields if field in value}


def print_json(value: Any) -> None:
    print(json.dumps(value, indent=2))
