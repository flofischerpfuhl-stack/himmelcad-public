# `.hcap` session package format (draft v1)

Status: **draft for C1 freeze**. Not yet a wire-stable contract until C1 exit.
Schema stubs: `schemas/himmelcap/`.

**Extension:** `.hcap` (short, mobile-friendly).
**Container:** ZIP (store or deflate).
**MIME:** `application/vnd.himmelcad.hcap+zip`.
**Internal format id:** `himmelcap-session` / `schemaVersion: 1` (stable string even if file extension is short).

Legacy prose may say `.himmelcap`; **canonical on-disk extension is `.hcap`**.

## Goals

- **One file per job** for share, USB, and cloud upload
- ZIP of session payload so office can import without multi-file chaos
- Enough media + metadata for PhotoLab with **weighted GNSS priors**
- Honest quality fields; content-addressed media (SHA-256)
- Fast field upload: prefer **office-ready** payload by default (selected frames + meta), optional full raw archive

## Why ZIP + `.hcap`

| Choice | Rationale |
| --- | --- |
| **ZIP (compressed)** | **One file** + **deflate compression** for faster cloud/USB transfer; universal; PhotoLab opens as archive |
| **`.hcap`** | Short on mobile share sheets; still unique enough with vendor MIME |
| **Not many loose files** | Crews lose folders; multi-file cloud upload is painful |

Compression is the point of ZIP here: smaller upload, single stream. It does **not** require packing every discarded preview or full unedited video.

### Package profiles (content, not “raw vs zip”)

Default is always a **compressed `.hcap` ZIP**. Profiles only choose *what* goes inside:

| Profile | Contents | Use |
| --- | --- | --- |
| **`office` (default)** | manifest, poses, trajectory, **selected** frames, checksums; optional short proxy | Field→office PhotoLab (smallest useful set, still zipped) |
| **`full` (optional)** | office + original high-bitrate video / extra candidates if kept | Reprocess / support |
| **Exploded dir** | same layout unzipped | Dev tests only |

Default share/upload = **compressed `office` `.hcap`**.
Implementation: ZIP with deflate (not store-only) for JPEG-friendly balance; store may be used only where already-compressed media gains nothing.

## Container layout

```text
job.hcap                    # ZIP
├── manifest.json           # required
├── poses.jsonl             # required if frames present
├── trajectory.jsonl        # optional dense track (map display)
├── media/
│   ├── frames/
│   │   ├── 000001.jpg
│   │   └── …
│   └── video/              # optional (full profile or short proxy)
│       └── capture.mp4
├── logs/                   # optional support (redacted)
│   └── gnss-summary.json
└── checksums.sha256        # required
```

PhotoLab accepts `.hcap` ZIP; optional exploded folder with `manifest.json` for tests.

## `manifest.json` (conceptual)

```json
{
  "format": "himmelcap-session",
  "schemaVersion": 1,
  "packageProfile": "office",
  "sessionId": "uuid",
  "createdAt": "2026-07-21T12:00:00.000Z",
  "app": { "name": "HimmelCAD Cap", "version": "0.1.0" },
  "device": {
    "platform": "android",
    "manufacturer": "Google",
    "model": "Pixel 8a"
  },
  "capture": {
    "mode": "smartstills",
    "preview": "video",
    "frameCount": 120
  },
  "positioning": {
    "bestTier": "t2NtripFloat",
    "correctionService": { "providerHint": "sapos-heps", "mountpoint": "…" }
  },
  "media": {
    "frames": [{ "index": 0, "path": "media/frames/000001.jpg", "sha256": "…" }]
  },
  "qualitySummary": {
    "meanHorizontalSigmaM": 0.35,
    "meanVerticalSigmaM": 0.7,
    "fixFraction": 0.12,
    "floatFraction": 0.7
  },
  "export": {
    "suggestedFileName": "2026-07-21_graben-nord.hcap"
  }
}
```

## Distribution paths (product)

| Path | Behaviour |
| --- | --- |
| **Cloud** | Linked Google Drive / Dropbox / OneDrive → upload `.hcap` to chosen folder |
| **Local / USB** | Save/share file → user copies via cable, Files app, stick |
| **Share sheet** | OS share (email, nearby, …) of the single `.hcap` |

Credentials for cloud stay in platform secure storage; Cap never embeds OAuth secrets in the package.

## Mapping to PhotoLab

Unchanged: poses → `CapturePositionPrior`; one job → one capture group. Importer recognizes `.hcap` and `format: himmelcap-session`.

## Versioning

Additive optional fields allowed; breaking changes bump `schemaVersion`.
