#!/usr/bin/env python3
"""Capture golden UI screenshots of the himmel:cap HTML prototype."""

from __future__ import annotations

import asyncio
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "screenshots"
BASE = "http://127.0.0.1:8765/"
# Phone frame is 390x844; studio chrome above — clip the .phone element


async def shot_phone(page, path: Path) -> None:
    phone = page.locator("#phone")
    await phone.wait_for(state="visible")
    await page.wait_for_timeout(400)
    await phone.screenshot(path=str(path), type="png")
    print(f"wrote {path.name}")


async def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(
            viewport={"width": 480, "height": 1000},
            device_scale_factor=2,
        )
        await page.goto(BASE, wait_until="networkidle")
        await page.wait_for_timeout(1500)

        # 01 map dark
        await shot_phone(page, OUT / "01-map-dark.png")

        # project dropdown
        await page.click("#btn-project-switch")
        await page.wait_for_timeout(300)
        await shot_phone(page, OUT / "02-project-dropdown.png")
        await page.keyboard.press("Escape")
        await page.evaluate("() => document.getElementById('project-dropdown').hidden = true")

        # job popup via first polyline is hard; open job programmatically
        await page.evaluate("() => openJob('j1')")
        await page.wait_for_timeout(400)
        await shot_phone(page, OUT / "03-job-detail.png")

        # notes accordion already open; scroll to notes
        await page.evaluate(
            """() => {
              const el = document.querySelector('#job-accordion');
              if (el) el.scrollTop = el.scrollHeight;
            }"""
        )
        # open job notes section - already open at bottom
        await page.wait_for_timeout(200)
        await shot_phone(page, OUT / "04-job-notes.png")

        # menu / projects
        await page.evaluate("() => { renderMenu(); navigate('menu'); }")
        await page.wait_for_timeout(400)
        await shot_phone(page, OUT / "05-menu-projects-jobs.png")

        # settings
        await page.evaluate("() => navigate('settings')")
        await page.wait_for_timeout(400)
        await shot_phone(page, OUT / "06-settings-top.png")
        await page.locator("#screen-settings .screen-body").evaluate(
            "el => { el.scrollTop = el.scrollHeight; }"
        )
        await page.wait_for_timeout(200)
        await shot_phone(page, OUT / "07-settings-cloud.png")

        # RTK add modal
        await page.evaluate("() => openRtkCreateModal()")
        await page.wait_for_timeout(300)
        await shot_phone(page, OUT / "08-rtk-create-modal.png")
        await page.evaluate(
            """() => {
              const h = document.getElementById('modal-host');
              h.classList.remove('on');
              h.innerHTML = '';
            }"""
        )

        # capture
        await page.evaluate("() => { applyGnssState(1); navigate('capture'); }")
        await page.wait_for_timeout(400)
        await shot_phone(page, OUT / "09-capture-idle.png")

        # recording
        await page.evaluate("() => startRecording()")
        await page.wait_for_timeout(1200)
        await shot_phone(page, OUT / "10-capture-recording.png")

        # save flow
        await page.evaluate("() => { if (window.recording) stopRecording(); else openSaveFlow(); }")
        await page.wait_for_timeout(800)
        await shot_phone(page, OUT / "11-save-job-dialog.png")
        await page.wait_for_timeout(1500)
        await shot_phone(page, OUT / "12-save-job-ready.png")

        # light theme map
        await page.evaluate(
            """() => {
              document.getElementById('save-overlay').classList.remove('on');
              setTheme('light');
              navigate('map');
            }"""
        )
        await page.wait_for_timeout(800)
        await shot_phone(page, OUT / "13-map-light.png")

        await page.evaluate("() => navigate('settings')")
        await page.wait_for_timeout(400)
        await shot_phone(page, OUT / "14-settings-light.png")

        # add note modal
        await page.evaluate(
            """() => {
              setTheme('dark');
              openJob('j1');
            }"""
        )
        await page.wait_for_timeout(400)
        await page.click("#btn-add-note")
        await page.wait_for_timeout(300)
        await shot_phone(page, OUT / "15-add-note-modal.png")

        # GNSS states on capture
        for i, name in enumerate(["red", "float", "fix", "single"]):
            await page.evaluate(f"() => {{ applyGnssState({i}); navigate('capture'); }}")
            await page.evaluate(
                """() => {
                  document.getElementById('save-overlay').classList.remove('on');
                }"""
            )
            await page.wait_for_timeout(250)
            await shot_phone(page, OUT / f"16-capture-gnss-{name}.png")

        await browser.close()

    manifest = OUT / "MANIFEST.md"
    files = sorted(OUT.glob("*.png"))
    lines = [
        "# himmel:cap UI golden screenshots",
        "",
        "Captured from `apps/cap-prototype` for Flutter visual parity.",
        f"Count: {len(files)}",
        "",
        "| File | Screen |",
        "| --- | --- |",
    ]
    labels = {
        "01-map-dark.png": "Map (dark) + trajectories + FAB",
        "02-project-dropdown.png": "Project switcher dropdown",
        "03-job-detail.png": "Job detail + accordion",
        "04-job-notes.png": "Job notes (append-only)",
        "05-menu-projects-jobs.png": "Menu: projects → jobs",
        "06-settings-top.png": "Settings top (theme, RTK)",
        "07-settings-cloud.png": "Settings cloud",
        "08-rtk-create-modal.png": "RTK profile create modal",
        "09-capture-idle.png": "Capture idle + GNSS HUD",
        "10-capture-recording.png": "Capture recording",
        "11-save-job-dialog.png": "Save job (packing)",
        "12-save-job-ready.png": "Save job (.hcap ready)",
        "13-map-light.png": "Map light theme",
        "14-settings-light.png": "Settings light theme",
        "15-add-note-modal.png": "Add note modal",
        "16-capture-gnss-red.png": "GNSS: no correction",
        "16-capture-gnss-float.png": "GNSS: float",
        "16-capture-gnss-fix.png": "GNSS: fix",
        "16-capture-gnss-single.png": "GNSS: phone GPS only",
    }
    for f in files:
        lines.append(f"| `{f.name}` | {labels.get(f.name, '')} |")
    manifest.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"manifest → {manifest}")


if __name__ == "__main__":
    asyncio.run(main())
