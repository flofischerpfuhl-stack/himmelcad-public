# himmel:Cap release artifacts

## APK

| File | Notes |
| --- | --- |
| `himmel-Cap-0.1.0-release.apk` | Release build (signed with debug key for local install) |
| `himmel-Cap-0.1.0-release.apk.sha256` | SHA-256 checksum |

**Install (USB / adb):**

```bash
adb install -r himmel-Cap-0.1.0-release.apk
```

Or copy the APK to the phone and open it (allow unknown sources).

**App id:** `de.himmelcad.cap`
**Label:** himmel:Cap

## Tests run before this build

```text
cd apps/cap && flutter test   # 15/15 passed
# includes UI goldens vs test/goldens/*
# includes prototype screenshot baseline checks
# includes .hcap ZIP packer + NTRIP client smoke
```

Prototype design references: `../cap-prototype/screenshots/`

## Known limits (honest)

- Integer RTK Fix: plug-in boundary (no GPL RTKLIB); NTRIP + float-class HUD ships
- Cloud OAuth: scaffold only
- Release signing: debug keystore until Play upload key is configured
