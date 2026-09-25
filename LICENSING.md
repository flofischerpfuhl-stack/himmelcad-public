# Licensing in plain language

Himmel:CAD is **source-available** under the
[Business Source License 1.1](LICENSE) with an Additional Use Grant. It is not
an Open Source license today, but every released version automatically becomes
Open Source (AGPL-3.0-or-later) four years after its release.

This page summarizes the [LICENSE](LICENSE). If the two ever differ, the
LICENSE applies.

## Free of charge

| Who                                                                            | Allowed                                                                   |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Anyone                                                                         | Read, copy, modify, fork and redistribute the code under the same license |
| Anyone, any company size                                                       | Evaluate, test and develop with it                                        |
| Private individuals                                                            | Use it for personal purposes                                              |
| Organizations with **3 or fewer people** (freelancers, small offices)          | Use it for any internal purpose, including paid work for your clients     |
| Schools, universities, non-profit research institutions, students and teachers | Teaching, learning, coursework and non-commercial academic research       |

"People" counts owners and partners active in the business, managing
directors, employees (also part-time, trainees and interns) and freelancers
who work mainly for you, across all companies in your group. No registration
or license key is needed. It works on trust.

## Needs a commercial license

- Organizations with **more than 3 people** using it in production. If you
  grow past 3, you have 90 days to get a license.
- Anyone offering Himmel:CAD or a fork of it to others as a hosted service,
  SaaS or API.

Contact: fernwork.absolute836@passmail.net

## Forks

Forks are welcome. A fork, and every modified copy, stays under this same
license with the same conditions. Forks must not use the Himmel:CAD name or
logo, because the license grants no trademark rights.

## Third-party code

Third-party components keep their own licenses. See
[LICENSES/THIRD_PARTY.md](LICENSES/THIRD_PARTY.md). New dependencies follow
[docs/DEPENDENCY-POLICY.md](docs/DEPENDENCY-POLICY.md). `cargo deny check` and
`node scripts/check-licenses.mjs --pnpm` enforce it in CI.

## Contributing

Contributions require agreeing to the [Contributor License Agreement](CLA.md).
It lets us offer commercial licenses while keeping the code public. You keep
your copyright, and every contribution that ships in a release is published
under the public license of that release.
