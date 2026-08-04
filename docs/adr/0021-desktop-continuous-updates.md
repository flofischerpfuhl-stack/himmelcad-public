# ADR 0021: Continuous desktop updates from a public GitHub mirror

## Status

Accepted for the alpha phase.

## Context

Builder and PhotoLab are developed in the public GitLab repository, while testers use
packaged applications on other machines. An alpha tester must be able to receive the
build produced from each successful `main` push without copying installers manually.
The delivery path must not introduce usage-based storage or bandwidth billing.

Both applications share one repository and release version, but they must not overwrite
each other's updater metadata. Windows portable packages and Debian packages also lack
the atomic replacement mechanism required by `electron-updater`.

## Decision

- GitLab remains the canonical repository.
- GitLab push-mirrors the repository to the public
  `flofischerpfuhl-stack/himmelcad-public` GitHub repository by using a repository-scoped
  SSH deploy key.
- Standard public GitHub Actions runners build the desktop artifacts. A monotonically
  increasing `0.1.<run-number>` version is assigned to both products for every mirrored
  `main` push.
- A release remains a GitHub draft until every required artifact and updater metadata
  file has been uploaded and checked. Only the complete release is published. The title
  and notes identify it as alpha, but GitHub's prerelease flag stays off: that makes
  `electron-updater` honor the separate `builder` and `photolab` metadata channels in a
  shared release instead of replacing them with a prerelease channel inferred from the
  tag.
- Builder uses the `builder` update channel and PhotoLab uses the `photolab` update
  channel. These names separate product feeds; they are not stability tiers.
- Packaged applications check shortly after launch and every four hours. The update is
  downloaded in the background. Once ready, a native dialog offers **Restart and
  install** or **Later**. Choosing Later installs on normal application exit.
- Automatic replacement is supported for Windows NSIS installations and Linux AppImage
  packages. Windows portable executables and Linux Debian packages remain manual
  downloads. macOS remains outside the current release scope.

## Consequences

Release serving and standard public runner time do not create usage-based Cloudflare
charges. The public GitHub repository becomes a read-only mirror; development and merge
authority stay in GitLab. A future version may move the feeds to
`updates.himmelcad.com`; installations delivered through GitHub can receive that feed
change through the normal updater first.

PhotoLab's curated native runtime is intentionally not rebuilt from scratch for every
push. Versioned, checksummed runtime bundles are kept as draft release assets, so they do
not become the latest public application release. The release workflow refuses to enable
PhotoLab until both platform bundle hashes are configured. This prevents an incomplete
PhotoLab build from being advertised as an update.
