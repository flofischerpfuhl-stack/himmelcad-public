# Implementation gate answers (owner, 2026-07-21)

| ID | Answer |
| --- | --- |
| A1 | Android **+ iOS** |
| C7 | **E1 preferred** (permissive on-device RTK lib, do not invent from scratch). Fallback **E2** if no license-clean engine. |
| B1 | User-entered NTRIP in app. Dev/test credentials only via **gitignored** env `HCAP_NTRIP_*` or secure storage — never commit |
| B2 | Cloud scaffold for enterprise-common providers; not fully functional v1 |
| B5 | `de.himmelcad.cap`, homescreen **himmel:Cap**, store-ready packaging (not sideload-only) |
| A3 | **EN + DE** |
| C4 | Cancel → **draft** job (marked draft, hidden on map, visible in menu) |
| C6 | Smartstills: **time** trigger |
| D1 | PhotoLab importer: **prepare** in this run |
| G1 | Emulator OK |
| A5 | Branch + commits + draft PR OK |

Secrets: only via OS secure storage / gitignored `.env.local` / shell env. Never commit.
