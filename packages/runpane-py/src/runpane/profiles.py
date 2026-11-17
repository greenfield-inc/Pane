"""`runpane profiles list|show|launch|runs`: Pane's profile library and the runs it follows.

Each prints the daemon's JSON unchanged with --json, and a readable summary otherwise. The npm
CLI's profiles.ts prints the same lines.
"""
from __future__ import annotations

import os
import sys
from typing import Any, Dict, List

from .daemon_actions import confirm_mutation
from .daemon_client import PaneDaemonClientError, invoke_daemon
from .local_control import print_json
from .notify import RunpaneError


def _invoke(parsed: Any, channel: str, request: Dict[str, Any], *required: str) -> Dict[str, Any]:
    result = invoke_daemon(channel, [request], pane_dir=parsed.pane_dir)
    if not isinstance(result, dict) or result.get("ok") is not True or any(key not in result for key in required):
        raise PaneDaemonClientError(f"Pane answered {channel} with an unexpected result: {result!r}.", "ERR_RUNPANE_DAEMON_RESPONSE")
    return result


def run_profiles_list(parsed: Any) -> int:
    result = _invoke(parsed, "runpane:profiles:list", {}, "profiles")
    if parsed.json:
        print_json(result)
        return 0
    profiles = result.get("profiles") or []
    if not profiles:
        print("No profiles.")
    for profile in profiles:
        print(_profile_line(profile))
    agent_farm = result.get("agentFarm")
    if agent_farm and agent_farm.get("state") != "ready":
        version = f" {agent_farm['version']}" if agent_farm.get("version") else ""
        error = f" ({agent_farm['error']})" if agent_farm.get("error") else ""
        print(f"Agent Farm{version}: {agent_farm.get('state')}{error}")
    own = result.get("ownAgentFarm")
    if own:
        names = ", ".join(profile.get("name") for profile in own.get("profiles") or []) or "no profiles"
        error = f" ({own['error']})" if own.get("error") else ""
        print(f"Your Agent Farm: {names}{error}")
    return 0


def run_profiles_show(parsed: Any) -> int:
    name = _require_profile_name(parsed)
    result = _invoke(parsed, "runpane:profiles:show", {"name": name}, "profile", "yaml")
    if parsed.json:
        print_json(result)
        return 0
    if parsed.yaml:
        text = result["yaml"]
        sys.stdout.write(text if text.endswith("\n") else f"{text}\n")
        return 0
    for line in _describe_profile(result["profile"]):
        print(line)
    return 0


def run_profiles_launch(parsed: Any) -> int:
    name = _require_profile_name(parsed)
    prompt = parsed.initial_input
    if prompt is None or not prompt.strip():
        raise RunpaneError(
            "ERR_PROFILES_PROMPT_REQUIRED",
            "runpane profiles launch needs --prompt: what you want done, which the profile's first agent step gets. Nothing was launched.",
            f'Run `runpane profiles launch {name} --prompt "<what you want done>" --yes`.',
        )
    confirm_mutation(parsed)
    request: Dict[str, Any] = {"name": name, "prompt": prompt, "repo": _launch_repo(parsed)}
    session = (parsed.session_id or "").strip() or (os.environ.get("PANE_ORCHESTRATION_SESSION_ID") or "").strip()
    if session:
        request["session"] = session
    if (parsed.profile_harness or "").strip():
        request["harness"] = parsed.profile_harness.strip()
    if parsed.agent_harness:
        request["agentHarness"] = parsed.agent_harness
    if parsed.profile_commands:
        request["commands"] = parsed.profile_commands
    result = _invoke(parsed, "runpane:profiles:launch", request, "run")
    run = result["run"]
    if parsed.json:
        print_json(result)
    else:
        print(_describe_launch(run))
    return 1 if run.get("state") == "failed" else 0


def run_profiles_runs(parsed: Any) -> int:
    result = _invoke(parsed, "runpane:profiles:runs", {}, "runs")
    if parsed.json:
        print_json(result)
        return 0
    runs = result.get("runs") or []
    if not runs:
        print("No profile runs. Start one with `runpane profiles launch <name> --prompt <text> --yes`.")
    for run in runs:
        error = f" · {run['error']}" if run.get("error") else ""
        attention = f" · {run['attention']}" if run.get("attention") else ""
        print(f"{run.get('id')} · {run.get('profile')} · {run.get('state')} · step {run.get('step')}{error}{attention}")
    return 0


def _require_profile_name(parsed: Any) -> str:
    name = (parsed.profile_name or "").strip()
    if name:
        return name
    done = "launched" if parsed.command == "profiles launch" else "shown"
    raise RunpaneError(
        "ERR_PROFILES_NAME_REQUIRED",
        f"runpane {parsed.command} needs the profile's name as its first word. Nothing was {done}.",
        f"See names with `runpane profiles list`, then run `runpane {parsed.command} <name>`.",
    )


def _launch_repo(parsed: Any) -> Any:
    """--repo; else the repo of the Pane this terminal runs in ($PANE_SESSION_ID), as Pane lists it;
    else the active repo (also when Pane does not list that Pane)."""
    if (parsed.repo or "").strip():
        return parsed.repo.strip()
    pane_id = (os.environ.get("PANE_SESSION_ID") or "").strip()
    if pane_id:
        listed = invoke_daemon("runpane:panes:list", [{}], pane_dir=parsed.pane_dir)
        for pane in (listed.get("panes") if isinstance(listed, dict) else None) or []:
            if pane.get("id") == pane_id and isinstance(pane.get("repoId"), (int, float)):
                return {"id": pane["repoId"]}
    return {"active": True}


def _profile_state(profile: Dict[str, Any]) -> str:
    if not profile.get("valid"):
        errors = profile.get("errors") or []
        return f"invalid: {errors[0].get('message') if errors else 'no reason given'}"
    if profile.get("teamOnly"):
        return "team only"
    return "launchable" if profile.get("launchable") else "not launchable"


def _profile_line(profile: Dict[str, Any]) -> str:
    on = "on" if profile.get("enabled") else "off"
    return f"{profile.get('name')} {profile.get('version') or '-'} · {profile.get('origin')} · {on} · {_profile_state(profile)}"


def _describe_profile(profile: Dict[str, Any]) -> List[str]:
    lines = [_profile_line(profile)]
    if profile.get("title"):
        lines.append(profile["title"])
    lines.append(f"File: {profile.get('file')}")
    body = profile.get("profile")
    if body:
        lines.extend(["", "Agents:"])
        for agent in body.get("agents") or []:
            lines.append(f"  {agent.get('id')}  runs {agent.get('runs')}")
        flow = body.get("flow")
        if flow:
            lines.extend(["", f"Steps (start: {flow.get('start')}):"])
            for step in flow.get("steps") or []:
                who = f" {step['agent']}" if step.get("agent") else ""
                # A command shows what it runs; its title only when that says something else.
                title = f": {step['title']}" if step.get("title") and step.get("title") != step.get("run") else ""
                lines.append(f"  {step.get('id')} ({step.get('kind')}{who}){title}")
                if step.get("run"):
                    lines.append(f"    run: {step['run']}")
                for edge in [*(step.get("outcomes") or []), *(step.get("choices") or [])]:
                    lines.append(f"    {edge.get('name')} → {edge.get('to')}")
                if step.get("next"):
                    lines.append(f"    (answer) → {step['next']}")
        else:
            lines.extend(["", "Steps: none (a team only, with no workflow to launch)"])
    errors = profile.get("errors") or []
    if errors:
        lines.extend(["", "Errors:"])
        for error in errors:
            lines.append(f"  {error.get('code')}: {error.get('message')} Fix: {error.get('fix')}")
    return lines


def _describe_launch(run: Dict[str, Any]) -> str:
    if run.get("state") == "failed":
        return f"Run {run.get('id')} of {run.get('profile')} failed at step {run.get('step')}: {run.get('error') or 'no reason given'}"
    pane = f" in Pane {run['paneId']}" if run.get("paneId") else ""
    attention = f" {run['attention']}" if run.get("attention") else ""
    return f"Started run {run.get('id')} of {run.get('profile')} in Session {run.get('sessionId')}: step {run.get('step')}{pane}.{attention}"
