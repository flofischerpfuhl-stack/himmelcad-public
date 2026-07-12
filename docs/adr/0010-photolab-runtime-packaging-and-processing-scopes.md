# ADR 0010: PhotoLab runtime packaging and processing scopes

- Status: Accepted
- Date: 2026-07-11

## Context

PhotoLab must execute the same offline pipeline on Linux and Windows, survive application restarts, and let users process either the complete image catalog or an explicit image selection. Large native and learned workers cannot live in `app.asar`, and a batch checkpoint from one image scope must never be resumed for another.

## Decision

- Electron keeps UI code in `app.asar`; native sidecars, model weights and audited external workers are immutable `extraResources`.
- Packaged worker paths are injected only by Electron main. The sandboxed renderer cannot select executables or mutate the worker environment.
- Network access is disabled for inference and PROJ. Every learned resource remains hash-pinned by its runtime preflight.
- Release staging never copies an `ldd`/DLL dependency closure from the host. A Python/ML or GDAL/PROJ bundle is included only after a complete signed file inventory proves a permissive-only closure. Until that curated bundle exists, packaged builds may use an explicitly installed system GDAL/PROJ toolchain for development but do not silently redistribute it.
- COLMAP is built from pinned COLMAP/vcpkg revisions with OpenMP, SuiteSparse, CGAL and other unapproved runtime closures disabled. Linux `ldd` and the corresponding Windows DLL inventory are release gates.
- Alignment and batch RPCs freeze `cameraEntityIds`. An empty list means the full imported catalog; a non-empty list is validated for uniqueness, existence and at least two images.
- The batch checkpoint identity hashes both the pipeline and image scope. Resume additionally checks project ID, immutable camera metadata and the current GCP collection.
- Persistent immutable `ProcessingSet` entities retain sorted camera membership plus a content hash. Alignment and batch selectors validate that hash before use.
- Published sparse records retain camera IDs and a monotone project publication sequence. Downstream products persist explicit parent/run lineage and must match the selected processing set; UUID ordering is never dependency resolution.
- A sparse reconstruction with at least three complete projected camera references is robustly aligned into the project Cartesian frame before MVS or GCP work.

## Consequences

- Multi-gigabyte installers are intentional once every incorporated runtime passes the license and trust inventory; a large but unaudited installer is rejected.
- Linux and Windows release jobs must validate the staged resource tree and execute worker preflights before signing.
- Multiple processing scopes can coexist without checkpoint collisions. The persistent ProcessingSet selector reuses the same frozen camera-ID contract without changing compute backends.
