#!/usr/bin/env python3
"""Brokered-grant sync/async smoke for the generated PhotoLab SDK."""

from __future__ import annotations

import asyncio
import argparse
import binascii
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import zlib
from collections.abc import Mapping
from pathlib import Path
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
SCRATCH_ROOT = REPOSITORY_ROOT / ".build/codex-scratch/pl-i2"
SDK_ROOT = REPOSITORY_ROOT / "sdk/python/src"
HOST = REPOSITORY_ROOT / "scripts/lib/photolab-automation-smoke-host.cjs"
MAX_SECONDS = 5 * 60
MAX_RSS_BYTES = 4 * 1024 * 1024 * 1024

sys.path.insert(0, str(SDK_ROOT))

from himmelcad import AsyncHimmelcadClient, HimmelcadClient, ProtocolError  # noqa: E402
from himmelcad.models import (  # noqa: E402
    PhotolabCancelJobResultV1,
    PhotolabImageQualityStartRequestV1,
    PhotolabImagesImportCommitRequestV1,
    PhotolabImagesImportCommitResultV1,
    PhotolabImagesImportInspectRequestV1,
    PhotolabJobIdRequestV1,
    PhotolabJobsListRequestV1,
    PhotolabJobsListResultV1,
    PhotolabPhotoImportBatchV1,
    PhotolabProjectCreateRequestV1,
    PhotolabStartJobResultV1,
)


def png_bytes(width: int, height: int, seed: int) -> bytes:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", binascii.crc32(kind + payload) & 0xFFFFFFFF)

    rows = bytearray()
    for y in range(height):
        rows.append(0)
        for x in range(width):
            rows.extend(((x * 3 + seed * 17) % 256, (y * 5 + seed * 29) % 256, (x + y + seed * 41) % 256))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(bytes(rows), 6)) + chunk(b"IEND", b"")


class HostTransport:
    def __init__(self, process: subprocess.Popen[str]) -> None:
        self.process = process
        self.next_id = 1
        self.lock = threading.Lock()

    def request(self, method: str, params: Mapping[str, Any]) -> Mapping[str, Any]:
        with self.lock:
            request_id = self.next_id
            self.next_id += 1
            response = self._exchange({"id": request_id, "method": method, "params": dict(params)})
        if response.get("id") != request_id:
            raise RuntimeError(f"automation host correlation mismatch: {response!r}")
        if isinstance(response.get("error"), Mapping):
            return {"error": response["error"]}
        result = response.get("result")
        if not isinstance(result, Mapping):
            raise RuntimeError(f"automation host returned a non-object result: {result!r}")
        return result

    def control(self, message: Mapping[str, Any]) -> Mapping[str, Any]:
        with self.lock:
            return self._exchange(message)

    def _exchange(self, message: Mapping[str, Any]) -> Mapping[str, Any]:
        if self.process.stdin is None or self.process.stdout is None:
            raise RuntimeError("automation host pipes are unavailable")
        self.process.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            stderr = self.process.stderr.read() if self.process.stderr is not None else ""
            raise RuntimeError(f"automation host exited early: {stderr}")
        response = json.loads(line)
        if not isinstance(response, Mapping):
            raise RuntimeError("automation host response is not an object")
        return response


class AsyncHostTransport:
    def __init__(self, transport: HostTransport) -> None:
        self.transport = transport

    async def request(self, method: str, params: Mapping[str, Any]) -> Mapping[str, Any]:
        return await asyncio.to_thread(self.transport.request, method, params)


def commit_request(batch: PhotolabPhotoImportBatchV1, operation_id: str) -> PhotolabImagesImportCommitRequestV1:
    return PhotolabImagesImportCommitRequestV1(
        operation_id=operation_id,
        images=tuple(
            {"photo": photo, "projectedReference": None, "tags": []} for photo in batch.photos
        ),
        local_metric=True,
    )


def sync_sequence(transport: HostTransport, project_grant: str, images_grant: str) -> None:
    client = HimmelcadClient(transport)
    client.negotiate("photolab-smoke-sync", required_capabilities=("document.read", "document.write"))
    try:
        client.photolab_project_create(
            PhotolabProjectCreateRequestV1(destination_grant_id="missing-grant", name="Denied")
        )
    except ProtocolError as error:
        assert error.raw_code == "permissionDenied"
    else:
        raise AssertionError("PhotoLab project creation without a grant was accepted")
    created = client.photolab_project_create(
        PhotolabProjectCreateRequestV1(destination_grant_id=project_grant, name="Sync smoke")
    )
    assert created.values["manifest"]["projectId"]
    inspected = client.photolab_images_import_inspect(
        PhotolabImagesImportInspectRequestV1(source_grant_ids=(images_grant,), operation_id="sync-inspect")
    )
    assert isinstance(inspected, PhotolabPhotoImportBatchV1) and len(inspected.photos) >= 2
    assert all("sourcePath" not in photo and "sourceGrantId" in photo for photo in inspected.photos)
    committed = client.photolab_images_import_commit(commit_request(inspected, "sync-commit"))
    assert isinstance(committed, PhotolabImagesImportCommitResultV1)
    assert committed.imported_entity_count == len(inspected.photos)
    jobs = client.photolab_jobs_list(PhotolabJobsListRequestV1(include_terminal=True))
    assert isinstance(jobs, PhotolabJobsListResultV1)
    started = client.photolab_images_quality_start(
        PhotolabImageQualityStartRequestV1(operation_id="sync-quality")
    )
    assert isinstance(started, PhotolabStartJobResultV1)
    cancelled = client.photolab_jobs_cancel(
        PhotolabJobIdRequestV1(job_id=str(started.job["id"]))
    )
    assert isinstance(cancelled, PhotolabCancelJobResultV1) and cancelled.first_request
    closed = client.photolab_project_close()
    assert closed.values.get("value") is None


async def async_sequence(transport: HostTransport, project_grant: str, images_grant: str) -> None:
    client = AsyncHimmelcadClient(AsyncHostTransport(transport))
    await client.negotiate("photolab-smoke-async", required_capabilities=("document.read", "document.write"))
    try:
        await client.photolab_project_create(
            PhotolabProjectCreateRequestV1(destination_grant_id="missing-grant", name="Denied")
        )
    except ProtocolError as error:
        assert error.raw_code == "permissionDenied"
    else:
        raise AssertionError("PhotoLab project creation without a grant was accepted")
    created = await client.photolab_project_create(
        PhotolabProjectCreateRequestV1(destination_grant_id=project_grant, name="Async smoke")
    )
    assert created.values["manifest"]["projectId"]
    inspected = await client.photolab_images_import_inspect(
        PhotolabImagesImportInspectRequestV1(source_grant_ids=(images_grant,), operation_id="async-inspect")
    )
    assert isinstance(inspected, PhotolabPhotoImportBatchV1) and len(inspected.photos) >= 2
    assert all("sourcePath" not in photo and "sourceGrantId" in photo for photo in inspected.photos)
    committed = await client.photolab_images_import_commit(commit_request(inspected, "async-commit"))
    assert isinstance(committed, PhotolabImagesImportCommitResultV1)
    assert committed.imported_entity_count == len(inspected.photos)
    jobs = await client.photolab_jobs_list(PhotolabJobsListRequestV1(include_terminal=True))
    assert isinstance(jobs, PhotolabJobsListResultV1)
    started = await client.photolab_images_quality_start(
        PhotolabImageQualityStartRequestV1(operation_id="async-quality")
    )
    assert isinstance(started, PhotolabStartJobResultV1)
    cancelled = await client.photolab_jobs_cancel(
        PhotolabJobIdRequestV1(job_id=str(started.job["id"]))
    )
    assert isinstance(cancelled, PhotolabCancelJobResultV1) and cancelled.first_request
    closed = await client.photolab_project_close()
    assert closed.values.get("value") is None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("sync", "async", "both"), default="both")
    args = parser.parse_args()
    started_at = time.monotonic()
    SCRATCH_ROOT.mkdir(parents=True, exist_ok=True)
    run_root = Path(tempfile.mkdtemp(prefix="smoke-", dir=SCRATCH_ROOT))
    process: subprocess.Popen[str] | None = None
    try:
        images = run_root / "images"
        sync_project = run_root / "sync-project.hcad"
        async_project = run_root / "async-project.hcad"
        images.mkdir()
        sync_project.mkdir()
        async_project.mkdir()
        for index in range(8):
            (images / f"synthetic-{index:02d}.png").write_bytes(png_bytes(192, 128, index))
        process = subprocess.Popen(
            ["node", str(HOST)],
            cwd=REPOSITORY_ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        transport = HostTransport(process)
        bootstrap = transport.control(
            {
                "control": "bootstrap",
                "syncProjectPath": str(sync_project),
                "asyncProjectPath": str(async_project),
                "imagesPath": str(images),
            }
        )
        grants = bootstrap["grants"]
        if args.mode in {"sync", "both"}:
            sync_sequence(transport, grants["syncProject"], grants["images"])
        if args.mode in {"async", "both"}:
            asyncio.run(async_sequence(transport, grants["asyncProject"], grants["images"]))
        shutdown = transport.control({"control": "shutdown"})
        assert shutdown.get("ok") is True
        process.wait(timeout=15)
        if process.returncode != 0:
            raise RuntimeError(f"automation host exited with {process.returncode}")
        elapsed = time.monotonic() - started_at
        max_rss = int(shutdown.get("maxRssBytes", 0))
        assert elapsed < MAX_SECONDS, f"smoke exceeded {MAX_SECONDS}s: {elapsed:.1f}s"
        assert max_rss < MAX_RSS_BYTES, f"smoke exceeded 4 GiB RSS: {max_rss} bytes"
        print(
            f"PhotoLab automation smoke passed ({args.mode}, {elapsed:.1f}s, "
            f"max RSS {max_rss / 1024 / 1024:.1f} MiB)"
        )
        return 0
    finally:
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        resolved = run_root.resolve()
        if resolved.parent == SCRATCH_ROOT.resolve() and resolved.name.startswith("smoke-"):
            shutil.rmtree(resolved)


if __name__ == "__main__":
    raise SystemExit(main())
