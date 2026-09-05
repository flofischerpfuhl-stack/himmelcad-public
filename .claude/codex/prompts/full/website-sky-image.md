Task: generate the hero background image for the Himmel:CAD website using your built-in image generation tool, then place it in the repository. Do not edit any HTML/CSS/JS.

Deliverable: `website/assets/img/sky-hero.jpg` — landscape, at least 2880×1620 px (16:9; if the tool caps resolution, generate the largest landscape size available and upscale to 2880 px wide with a high-quality resampler, e.g. Python Pillow LANCZOS; sips/ImageMagick if present). JPEG quality 88–92, progressive, target ≤ 900 kB. Also write `website/assets/img/sky-hero@1440.jpg` (1440 px wide, ≤ 300 kB) for mobile.

Image brief (the site is lawn.video-style: a full-bleed rendered hero with a huge wordmark and stickers on top — the image must be beautiful on its own but calm enough to carry black text top-left and stickers right):
- Subject: a vast anime-style summer sky (Makoto-Shinkai-esque: painterly, luminous, high detail, no characters, no text, no logos, no lens flare artifacts). Towering cumulonimbus clouds on the right third, soft cirrus in the upper left, deep saturated cerulean-to-azure gradient, sunlight from the upper right rim-lighting the clouds.
- Bottom fifth: a thin, quiet horizon of green alpine foothills with a faint survey road and a tiny surveying tripod silhouette on a ridge (small — a detail, not the subject), very light atmospheric haze.
- Composition: keep the upper-left quadrant relatively plain (open sky, minimal cloud detail) so a black wordmark reads there. Keep contrast in the mid-tones; no pure white blowouts larger than a few percent of the frame.
- Palette anchors: sky #2E7BD6 → #7FC0F5; cloud shadow #9DB7D9; hills #3C6B3A/#6E9A5A.
- Style words: anime background art, cel-painted clouds, clean gradients, cinematic, 8k matte painting. Negative: text, watermark, people, buildings, vehicles, CGI plastic look, HDR halo.

Steps:
1. Generate 2 candidates with the image generation tool. Pick the one with the clearer upper-left area and better cloud volume on the right. If the tool returns square/portrait only, generate the widest option and then outpaint/crop is not possible — in that case choose the landscape-most result and letterbox-crop to 16:9 centered on the horizon.
2. Save the chosen candidate as `website/assets/img/sky-hero.jpg` and the 1440 derivative; report dimensions and file sizes with `python3 -c "from PIL import Image; ..."` or `file`/`identify`.
3. Also save the rejected candidate as `website/assets/img/sky-hero-alt.jpg` (same processing) so the owner can swap.
4. Print a short report: which tool/model was used, sizes, and one line why the chosen candidate won.

Constraints: only files under website/assets/img/. No other changes. Budget: keep it tight — two generations, no iteration loops.
