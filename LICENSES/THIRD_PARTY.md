# Third-Party Licenses

This file tracks dependencies that are incorporated into the product build.

Important: entries under `libs/` are currently references/inspiration unless an
entry below explicitly says they are used in the product build.

| Name | Version/Commit | License | URL | Use |
| --- | --- | --- | --- | --- |
| None yet | - | - | - | No product dependency has been accepted yet |

## Policy

Allowed licenses:

- MIT
- BSD-2-Clause
- BSD-3-Clause
- Apache-2.0
- ISC
- MPL-2.0, if file-level separation is preserved
- Zlib
- CC0
- BSL 1.1

Forbidden licenses for incorporated product code:

- GPL
- LGPL, except as a separately loaded external plugin after explicit ADR
- AGPL
- SSPL
- unknown/proprietary dependencies without written permission

Every accepted dependency must include:

- name,
- exact version or commit,
- license,
- upstream URL,
- why it is used,
- whether it is shipped in Polyshape, Weltview, or only build tooling.
