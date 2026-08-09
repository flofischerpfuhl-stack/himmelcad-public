# HimmelCAD Cap — interactive UI prototype

Clickable phone UI for owner iteration. **Not** production Flutter.

## Run

```bash
cd apps/cap-prototype
python3 -m http.server 8765
# open http://127.0.0.1:8765/
```

Or: `npx --yes serve -p 8765 .`

## What is mocked

- Main map (satellite tiles) + job trajectories (screen-space stroke)
- Job popup → job screen (accordion)
- Capture screen (GNSS HUD + start/stop + fake processing)
- Settings (theme, RTK profiles, cloud links, export)
- Dark / light themes (HimmelCAD tokens)

## Path to Flutter

1. Iterate this prototype until flows feel right
2. Freeze `docs/himmelcap/UI-BRIEF.md`
3. Rebuild screens in Flutter with same structure/states (not CSS copy-paste)

## Files

- `index.html` — shell
- `styles.css` — tokens + layout
- `app.js` — navigation + mock data
