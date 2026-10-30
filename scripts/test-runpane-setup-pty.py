"""Exercise real terminal prompts and stdin handoff without installing a remote host."""
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import tempfile
import time


def check_setup_terminal():
    if os.name == "nt":
        print("PTY setup check skipped on Windows; wizard contract checks still run")
        return
    import pty
    import fcntl
    import struct
    import termios

    cli = Path(__file__).resolve().parents[1] / "packages/runpane/dist/cli.js"
    node = shutil.which("node")
    with tempfile.TemporaryDirectory(prefix="pane-setup-pty-") as home:
        executable = Path(home) / ".local/bin/pane"
        executable.parent.mkdir(parents=True)
        executable.write_text(
            "#!/usr/bin/env node\n"
            "console.log('SETUP_ARGS:' + JSON.stringify(process.argv.slice(2)));\n"
            "require('node:readline').createInterface({input:process.stdin,output:process.stdout})"
            ".question('Test login: ', answer => { console.log('LOGIN:' + answer); process.exit(0); });\n"
        )
        executable.chmod(0o755)
        # Linux resolves the fake host via HOME; macOS has fixed app paths, so
        # limit the real handoff check to Linux. Cancellation works on both.
        for cancel in ([False, True] if os.sys.platform == "linux" else [True]):
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 120, 0, 0))
            env = {**os.environ, "HOME": home, "TERM": "xterm-256color", "RUNPANE_TELEMETRY_DISABLED": "1"}
            env.pop("CI", None)
            process = subprocess.Popen([node, str(cli), "setup"], stdin=slave, stdout=slave, stderr=slave, env=env)
            os.close(slave)
            transcript = b""

            def read_until(marker):
                nonlocal transcript
                deadline = time.monotonic() + 15
                while marker not in transcript:
                    if time.monotonic() > deadline:
                        raise AssertionError(f"Timed out waiting for {marker!r}: {transcript!r}")
                    if select.select([master], [], [], 0.1)[0]:
                        try:
                            data = os.read(master, 65536)
                        except OSError:
                            data = b""
                        if not data:
                            raise AssertionError(f"Terminal closed before {marker!r}: {transcript!r}")
                        transcript += data

            try:
                read_until(b"What should this machine do?")
                if cancel:
                    os.write(master, b"\x03")
                    read_until(b"Setup cancelled.")
                else:
                    os.write(master, b"\x1b[B\r")
                    read_until(b"Name this host")
                    os.write(master, b"PTY Host\r")
                    read_until(b"Test login: ")
                    os.write(master, b"signed-in\n")
                    read_until(b"Remote host setup finished.")
                    assert b"LOGIN:signed-in" in transcript, transcript
                    args_line = transcript.split(b"SETUP_ARGS:", 1)[1].split(b"\r\n", 1)[0]
                    args = json.loads(args_line)
                    assert args[-7:] == ["--remote-setup", "--label", "PTY Host", "--prefer-tunnel", "tailscale", "--interactive-tailscale-setup", "--auto-listen-port"], args
                assert process.wait(timeout=10) == 0
                assert b"Error:" not in transcript, transcript
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
                os.close(master)
    print("Real terminal setup and cancellation checks passed")


def check_json_mutation_in_terminal():
    """With --json, a mutation without --yes refuses at once with a JSON error instead of prompting."""
    if os.name == "nt":
        return
    import pty
    import sys

    root = Path(__file__).resolve().parents[1]
    clis = {
        "npm": [shutil.which("node"), str(root / "packages/runpane/dist/cli.js")],
        "pip": [sys.executable, "-m", "runpane"],
    }
    with tempfile.TemporaryDirectory(prefix="pane-json-pty-") as pane_dir:
        env = {**os.environ, "PANE_DIR": pane_dir, "PYTHONPATH": str(root / "packages/runpane-py/src"), "RUNPANE_TELEMETRY_DISABLED": "1"}
        for name, cli in clis.items():
            master, slave = pty.openpty()
            process = subprocess.Popen(
                [*cli, "repos", "rename", "--repo", "3", "--name", "Lev", "--json"],
                stdin=slave, stdout=slave, stderr=subprocess.PIPE, env=env,
            )
            os.close(slave)
            stdout = b""
            deadline = time.monotonic() + 15
            while True:
                if time.monotonic() > deadline:
                    process.kill()
                    raise AssertionError(f"{name} repos rename --json waited for input instead of refusing: {stdout!r}")
                if select.select([master], [], [], 0.1)[0]:
                    try:
                        data = os.read(master, 65536)
                    except OSError:
                        data = b""
                    stdout += data
                    if data:
                        continue
                if process.poll() is not None:
                    break
            stderr = process.stderr.read()
            os.close(master)
            assert process.returncode == 1, (name, process.returncode, stdout, stderr)
            error = json.loads(stdout.decode())["error"]
            assert error["code"] == "ERR_RUNPANE_CONFIRMATION_REQUIRED", (name, error)
            assert error["next"] == "Rerun with --yes.", (name, error)
            assert b"Next: Rerun with --yes." in stderr, (name, stderr)
    print("JSON mutations refuse without prompting in a real terminal")


if __name__ == "__main__":
    check_setup_terminal()
    check_json_mutation_in_terminal()
