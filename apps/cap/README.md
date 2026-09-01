# Himmel:CAD Cap (`apps/cap`)

Flutter field app for **Himmel:CAD Cap** — Android + iOS.

Application id: `de.himmelcad.cap`.

## Run

```bash
export PATH="$HOME/flutter/bin:$PATH"
cd apps/cap
flutter pub get
flutter run
# Android release-oriented APK (store pipeline later)
flutter build apk --debug
```

### Dev NTRIP (never commit)

```bash
flutter run \
  --dart-define=HCAP_NTRIP_HOST=… \
  --dart-define=HCAP_NTRIP_MOUNT=… \
  --dart-define=HCAP_NTRIP_USER=… \
  --dart-define=HCAP_NTRIP_PASS=…
```

Or enter credentials in **Settings → RTK** (stored in secure storage).

## Features (this MVP)

- Map (satellite tiles) + projects/jobs + drafts (menu only)
- Capture: time-based smartstills + GNSS HUD + `.hcap` packer
- NTRIP client + correction-aware float path (E1 integer AR plug-in boundary)
- Cloud scaffold (Drive/Dropbox/OneDrive) — OAuth later
- English product UI target. The checked-in German localization is legacy debt
  tracked by `docs/himmelcap/ROADMAP.md`.
- Visual baseline: `../cap-prototype/screenshots/`

## PhotoLab

Importer prep: `crates/himmelcad-io/src/hcap_import.rs` (`preview_hcap_path`).

## Docs

`docs/himmelcap/`
