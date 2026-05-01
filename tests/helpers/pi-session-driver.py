#!/usr/bin/env python3

from __future__ import annotations

import fcntl
import json
import os
import pty
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import urlopen


def pump(master_fd: int, log_handle) -> None:
    while True:
        try:
            chunk = os.read(master_fd, 65536)
        except BlockingIOError:
            return
        except OSError:
            return
        if not chunk:
            return
        log_handle.write(chunk)
        log_handle.flush()


def stop_process(proc: subprocess.Popen[bytes]) -> None:
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)


def tail_text(path: Path, line_count: int = 80) -> str:
    if not path.exists():
        return ""
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return ""
    return "\n".join(lines[-line_count:])


def fail(
    message: str,
    *,
    proc: subprocess.Popen[bytes] | None,
    master_fd: int | None,
    log_handle,
    log_path: Path,
) -> None:
    if master_fd is not None and log_handle is not None:
        pump(master_fd, log_handle)
    if proc is not None:
        stop_process(proc)
    print(message, file=sys.stderr)
    print(f"Session log: {log_path}", file=sys.stderr)
    tail = tail_text(log_path)
    if tail:
        print("Recent log output:", file=sys.stderr)
        print(tail, file=sys.stderr)
    raise SystemExit(1)


def ensure_ready(
    proc: subprocess.Popen[bytes],
    master_fd: int,
    log_handle,
    log_path: Path,
    timeout_seconds: float = 10.0,
) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        pump(master_fd, log_handle)
        if log_path.exists() and log_path.stat().st_size > 0:
            return
        if proc.poll() is not None:
            fail(
                "pi exited before the interactive session became ready.",
                proc=proc,
                master_fd=master_fd,
                log_handle=log_handle,
                log_path=log_path,
            )
        time.sleep(0.05)

    fail(
        "Timed out waiting for the interactive session to render.",
        proc=proc,
        master_fd=master_fd,
        log_handle=log_handle,
        log_path=log_path,
    )


def wait_for_log(
    proc: subprocess.Popen[bytes],
    master_fd: int,
    log_handle,
    log_path: Path,
    markers: list[str],
    timeout_seconds: float,
    fail_markers: list[str],
) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        pump(master_fd, log_handle)
        log_text = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
        if any(marker in log_text for marker in markers):
            return
        if any(marker in log_text for marker in fail_markers):
            fail(
                "The pi session reported an error marker while waiting for log output.",
                proc=proc,
                master_fd=master_fd,
                log_handle=log_handle,
                log_path=log_path,
            )
        if proc.poll() is not None:
            fail(
                "pi exited before the expected log marker appeared.",
                proc=proc,
                master_fd=master_fd,
                log_handle=log_handle,
                log_path=log_path,
            )
        time.sleep(0.05)

    fail(
        "Timed out waiting for the expected log marker.",
        proc=proc,
        master_fd=master_fd,
        log_handle=log_handle,
        log_path=log_path,
    )


def wait_for_path(
    proc: subprocess.Popen[bytes],
    master_fd: int,
    log_handle,
    log_path: Path,
    target_path: Path,
    should_exist: bool,
    timeout_seconds: float,
) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        pump(master_fd, log_handle)
        if target_path.exists() == should_exist:
            return
        if proc.poll() is not None:
            fail(
                f"pi exited before path state changed for {target_path}.",
                proc=proc,
                master_fd=master_fd,
                log_handle=log_handle,
                log_path=log_path,
            )
        time.sleep(0.05)

    fail(
        f"Timed out waiting for path state change for {target_path}.",
        proc=proc,
        master_fd=master_fd,
        log_handle=log_handle,
        log_path=log_path,
    )


def wait_for_line_count(
    proc: subprocess.Popen[bytes],
    master_fd: int,
    log_handle,
    log_path: Path,
    target_path: Path,
    minimum_lines: int,
    timeout_seconds: float,
) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        pump(master_fd, log_handle)
        if target_path.exists():
            try:
                line_count = len(target_path.read_text(encoding="utf-8", errors="replace").splitlines())
            except OSError:
                line_count = 0
            if line_count >= minimum_lines:
                return
        if proc.poll() is not None:
            fail(
                f"pi exited before {target_path} reached {minimum_lines} lines.",
                proc=proc,
                master_fd=master_fd,
                log_handle=log_handle,
                log_path=log_path,
            )
        time.sleep(0.05)

    fail(
        f"Timed out waiting for {target_path} to reach {minimum_lines} lines.",
        proc=proc,
        master_fd=master_fd,
        log_handle=log_handle,
        log_path=log_path,
    )


def wait_for_http_number(
    proc: subprocess.Popen[bytes],
    master_fd: int,
    log_handle,
    log_path: Path,
    url: str,
    field: str,
    minimum: int,
    timeout_seconds: float,
) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        pump(master_fd, log_handle)
        try:
            with urlopen(url, timeout=2) as response:
                payload = json.loads(response.read().decode("utf-8"))
            value = int(payload.get(field, 0))
        except Exception:
            value = 0
        if value >= minimum:
            return
        if proc.poll() is not None:
            fail(
                f"pi exited before {url} field {field} reached {minimum}.",
                proc=proc,
                master_fd=master_fd,
                log_handle=log_handle,
                log_path=log_path,
            )
        time.sleep(0.05)

    fail(
        f"Timed out waiting for {url} field {field} to reach {minimum}.",
        proc=proc,
        master_fd=master_fd,
        log_handle=log_handle,
        log_path=log_path,
    )


def perform_action(
    action: dict[str, object],
    *,
    proc: subprocess.Popen[bytes],
    master_fd: int,
    log_handle,
    log_path: Path,
) -> None:
    action_type = action.get("type")

    if action_type == "send":
        text = action.get("text")
        if not isinstance(text, str):
            raise SystemExit("send action requires a text field")
        os.write(master_fd, text.encode("utf-8"))
        return

    if action_type == "sleep":
        seconds = float(action.get("seconds", 0.0))
        time.sleep(seconds)
        pump(master_fd, log_handle)
        return

    if action_type == "wait_log":
        markers = action.get("markers", [])
        fail_markers = action.get("failMarkers", [])
        if not isinstance(markers, list) or not all(isinstance(marker, str) for marker in markers):
            raise SystemExit("wait_log action requires markers")
        if not isinstance(fail_markers, list) or not all(
            isinstance(marker, str) for marker in fail_markers
        ):
            raise SystemExit("wait_log action failMarkers must be a string list")
        wait_for_log(
            proc,
            master_fd,
            log_handle,
            log_path,
            markers,
            float(action.get("timeout", 10.0)),
            fail_markers,
        )
        return

    if action_type == "wait_path":
        raw_path = action.get("path")
        if not isinstance(raw_path, str):
            raise SystemExit("wait_path action requires a path")
        wait_for_path(
            proc,
            master_fd,
            log_handle,
            log_path,
            Path(raw_path),
            bool(action.get("exists", True)),
            float(action.get("timeout", 10.0)),
        )
        return

    if action_type == "wait_line_count":
        raw_path = action.get("path")
        if not isinstance(raw_path, str):
            raise SystemExit("wait_line_count action requires a path")
        wait_for_line_count(
            proc,
            master_fd,
            log_handle,
            log_path,
            Path(raw_path),
            int(action.get("minimumLines", 1)),
            float(action.get("timeout", 10.0)),
        )
        return

    if action_type == "wait_http_number":
        url = action.get("url")
        field = action.get("field")
        if not isinstance(url, str) or not isinstance(field, str):
            raise SystemExit("wait_http_number action requires url and field")
        wait_for_http_number(
            proc,
            master_fd,
            log_handle,
            log_path,
            url,
            field,
            int(action.get("minimum", 1)),
            float(action.get("timeout", 10.0)),
        )
        return

    raise SystemExit(f"Unknown action type: {action_type}")


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: pi-session-driver.py SPEC_PATH")

    spec_path = Path(sys.argv[1]).resolve()
    spec = json.loads(spec_path.read_text(encoding="utf-8"))

    cwd = spec.get("cwd")
    pi_bin = spec.get("piBin")
    session_log = spec.get("sessionLog")
    unset_env = spec.get("unsetEnv", [])
    actions = spec.get("actions", [])

    if not isinstance(cwd, str) or not isinstance(pi_bin, str) or not isinstance(session_log, str):
        raise SystemExit("Spec must include cwd, piBin, and sessionLog strings")
    if not isinstance(unset_env, list) or not all(isinstance(key, str) for key in unset_env):
        raise SystemExit("unsetEnv must be a string list")
    if not isinstance(actions, list):
        raise SystemExit("actions must be a list")

    env = os.environ.copy()
    for key in unset_env:
        env.pop(key, None)
    for key, value in spec.get("env", {}).items():
        env[str(key)] = str(value)

    log_path = Path(session_log).resolve()
    log_path.parent.mkdir(parents=True, exist_ok=True)

    master_fd, slave_fd = pty.openpty()
    flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
    fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

    proc = subprocess.Popen([pi_bin, "--no-session"], cwd=cwd, env=env, stdin=slave_fd, stdout=slave_fd, stderr=slave_fd)
    os.close(slave_fd)

    try:
        with log_path.open("ab") as log_handle:
            ensure_ready(proc, master_fd, log_handle, log_path)
            time.sleep(0.25)
            pump(master_fd, log_handle)

            for action in actions:
                if not isinstance(action, dict):
                    raise SystemExit("Each action must be an object")
                perform_action(action, proc=proc, master_fd=master_fd, log_handle=log_handle, log_path=log_path)

            for _ in range(10):
                pump(master_fd, log_handle)
                time.sleep(0.05)

            stop_process(proc)
            pump(master_fd, log_handle)
    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass

    print(json.dumps({"sessionLog": str(log_path)}))


if __name__ == "__main__":
    main()