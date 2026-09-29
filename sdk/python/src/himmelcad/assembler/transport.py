"""Transports for the Assembler agent API: headless stdio and the in-app loopback endpoint.

Both carry the same JSON-RPC 2.0 messages to the same canonical command layer,
so a script written against one runs unchanged against the other.
"""
from __future__ import annotations

import itertools
import json
import os
import queue
import shutil
import subprocess
import threading
import urllib.error
import urllib.request
from collections import deque
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Protocol

from .errors import AssemblerError, TransportError, error_from_rpc

DEFAULT_TIMEOUT_S = 300.0


class Transport(Protocol):
    """Sends one request and returns the ``result`` (raising :class:`AssemblerError` on errors)."""

    def request(self, method: str, params: Mapping[str, Any]) -> Any: ...

    def close(self) -> None: ...


def _unwrap(response: Mapping[str, Any], request_id: int, method: str) -> Any:
    if response.get("id") != request_id and response.get("id") is not None:
        raise TransportError(raw_code="internal", message=f"response id {response.get('id')!r} does not match request {request_id}")
    error = response.get("error")
    if isinstance(error, Mapping):
        raise error_from_rpc(error, method)
    if "result" not in response:
        raise TransportError(raw_code="internal", message="JSON-RPC response has neither result nor error")
    return response["result"]


def find_headless_command() -> list[str]:
    """Locates ``assembler-headless``.

    Order: ``HCASM_HEADLESS`` (a ``.mjs``/``.js`` path or an executable), the
    repository checkout this package lives in (``apps/assembler/bin``), then
    ``assembler-headless`` on ``PATH``. ``HCASM_NODE`` overrides ``node``.
    """
    node = os.environ.get("HCASM_NODE", "node")
    configured = os.environ.get("HCASM_HEADLESS")
    if configured:
        return [node, configured] if configured.endswith((".mjs", ".js")) else [configured]
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "apps" / "assembler" / "bin" / "assembler-headless.mjs"
        if candidate.is_file():
            return [node, str(candidate)]
    on_path = shutil.which("assembler-headless")
    if on_path:
        return [on_path]
    raise TransportError(
        raw_code="internal",
        message="assembler-headless not found",
        hint="Build it (pnpm --filter @himmelcad/assembler build:headless) or set HCASM_HEADLESS.",
    )


class StdioTransport:
    """Runs ``assembler-headless`` as a child process (JSON-RPC, one object per line)."""

    def __init__(self, command: Sequence[str] | None = None, *, cwd: str | os.PathLike[str] | None = None, timeout: float = DEFAULT_TIMEOUT_S) -> None:
        self.command = list(command) if command is not None else find_headless_command()
        self.timeout = timeout
        self._ids = itertools.count(1)
        self._lines: queue.Queue[str | None] = queue.Queue()
        self._stderr: deque[str] = deque(maxlen=200)
        self._lock = threading.Lock()
        try:
            self._process = subprocess.Popen(
                self.command,
                cwd=cwd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                bufsize=1,
            )
        except OSError as error:
            raise TransportError(raw_code="internal", message=f"cannot start {self.command!r}: {error}") from error
        threading.Thread(target=self._pump_stdout, daemon=True).start()
        threading.Thread(target=self._pump_stderr, daemon=True).start()

    def _pump_stdout(self) -> None:
        assert self._process.stdout is not None
        for line in self._process.stdout:
            self._lines.put(line)
        self._lines.put(None)

    def _pump_stderr(self) -> None:
        assert self._process.stderr is not None
        for line in self._process.stderr:
            self._stderr.append(line.rstrip())

    @property
    def stderr_tail(self) -> str:
        return "\n".join(self._stderr)

    def request(self, method: str, params: Mapping[str, Any]) -> Any:
        with self._lock:
            if self._process.poll() is not None:
                raise TransportError(raw_code="internal", message=f"assembler-headless exited ({self._process.returncode})", details={"stderr": self.stderr_tail})
            request_id = next(self._ids)
            message = json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": dict(params)})
            assert self._process.stdin is not None
            try:
                self._process.stdin.write(message + "\n")
                self._process.stdin.flush()
            except OSError as error:
                raise TransportError(raw_code="internal", message=f"write failed: {error}", details={"stderr": self.stderr_tail}) from error
            try:
                line = self._lines.get(timeout=self.timeout)
            except queue.Empty as error:
                raise TransportError(raw_code="cancelled", message=f"{method} timed out after {self.timeout} s") from error
            if line is None:
                raise TransportError(raw_code="internal", message="assembler-headless closed its output", details={"stderr": self.stderr_tail})
            return _unwrap(json.loads(line), request_id, method)

    def close(self) -> None:
        if self._process.poll() is None:
            try:
                assert self._process.stdin is not None
                self._process.stdin.close()
                self._process.wait(timeout=10)
            except (OSError, subprocess.TimeoutExpired):
                self._process.kill()
                self._process.wait()


class LoopbackTransport:
    """Talks to the desktop app's opt-in "Agent access" endpoint (loopback, bearer token)."""

    def __init__(self, url: str, token: str, *, timeout: float = DEFAULT_TIMEOUT_S) -> None:
        if not url.startswith(("http://127.0.0.1:", "http://localhost:")):
            raise TransportError(raw_code="permissionDenied", message="the Assembler endpoint is loopback-only", hint="Use the URL shown by the app's Agent access indicator.")
        self.url = url
        self.token = token
        self.timeout = timeout
        self._ids = itertools.count(1)

    @classmethod
    def from_connection(cls, text: str | None = None) -> LoopbackTransport:
        """From the app's "Copy connection" JSON, or ``HCASM_AGENT_URL``/``HCASM_AGENT_TOKEN``."""
        if text:
            data = json.loads(text)
            return cls(str(data["url"]), str(data["token"]))
        url = os.environ.get("HCASM_AGENT_URL")
        token = os.environ.get("HCASM_AGENT_TOKEN")
        if not url or not token:
            raise TransportError(raw_code="permissionDenied", message="no Agent access connection given", hint="Turn on Agent access in the app and pass its connection text, or set HCASM_AGENT_URL and HCASM_AGENT_TOKEN.")
        return cls(url, token)

    def request(self, method: str, params: Mapping[str, Any]) -> Any:
        request_id = next(self._ids)
        body = json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": dict(params)}).encode("utf-8")
        request = urllib.request.Request(self.url, data=body, method="POST", headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.token}"})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            try:
                payload = json.loads(error.read().decode("utf-8"))
            except (ValueError, OSError):
                raise TransportError(raw_code="internal", message=f"HTTP {error.code}") from error
        except (urllib.error.URLError, OSError) as error:
            raise TransportError(raw_code="internal", message=f"cannot reach {self.url}: {error}", hint="Is Agent access still on in the app?") from error
        return _unwrap(payload, request_id, method)

    def close(self) -> None:
        return None


__all__ = ["AssemblerError", "LoopbackTransport", "StdioTransport", "Transport", "find_headless_command"]
