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


if __name__ == "__main__":
    check_setup_terminal()
