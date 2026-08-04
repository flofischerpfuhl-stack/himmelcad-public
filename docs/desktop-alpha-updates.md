# Desktop alpha updates

Every successful mirror of GitLab `main` to the public GitHub repository starts the
`Desktop alpha update` workflow. The workflow assigns both applications the version
`0.1.<GitHub run number>`, builds their installers, uploads files directly to a private
draft, checks the product-specific update metadata, and only then publishes the release.
No Cloudflare service is used.

Windows users must install the `setup.exe` package and Linux users must run the AppImage
to receive automatic updates. Debian packages are published for convenience but cannot
replace themselves atomically. Portable Windows executables remain available through the
manual packaging command; the continuous update release deliberately builds only NSIS,
because a portable executable cannot replace itself reliably.

## PhotoLab runtime bootstrap

PhotoLab packaging also needs the audited COLMAP, DeDoDe Python/ONNX, GDAL and PROJ
runtime closure. These large, slowly changing inputs are not rebuilt for every source
push. They are restored from these checksum-pinned draft assets in the same repository:

- `photolab-runtime-linux-x64.tar.zst`
- `photolab-runtime-win32-x64.tar.zst`

Each archive is extracted at the repository root and therefore contains repository-
relative `.build/...` and `vendor/...` paths consumed by
`scripts/stage-photolab-runtime.mjs`. Keep the draft tag `desktop-runtime-v1`; a draft
cannot displace the latest public application release.

PhotoLab jobs remain disabled until both archives have passed the existing release
inventory and package smoke tests. To enable them, configure the GitHub repository
variables below:

- `PHOTOLAB_RUNTIME_BUNDLES_READY=true`
- `PHOTOLAB_RUNTIME_LINUX_SHA256=<64 lowercase hex characters>`
- `PHOTOLAB_RUNTIME_WINDOWS_SHA256=<64 lowercase hex characters>`

If any required job or metadata file is missing, the workflow deletes its draft and tag.
Existing installations therefore continue using the previous complete release.
