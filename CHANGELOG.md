# Changelog

All notable changes to `dsh-model-probe`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases from 0.1.1 onwards carry a GitHub tag (`v0.1.1`, `v0.1.2`, `v0.1.3`, …); 0.1.0
never got one and links to npm instead. GitHub Releases were first published with 0.1.4,
so the entries below are reconstructed from those tags, the npm publish times and the
commit history.

## [0.1.5] — 2026-09-11

### Changed

- The README is an introduction to the plugin again: it opens with a **What it is**
  section (audits before it fills, the four fields, both surfaces, both protocols, no
  runtime dependencies) instead of carrying version history. Release notes live here in
  `CHANGELOG.md`, in the git tags and in the GitHub Releases.

## [0.1.4] — 2026-09-11

### Added

- `CHANGELOG.md`, shipped inside the npm tarball.

### Changed

- Package description now leads with what the package is (a DeepSeek Harness plugin),
  and two keywords were added for discoverability.

### Documentation

- **Removed a capability the code never had.** The evidence table listed a fourth
  "bisection / enumeration" layer for the case where constraint elicitation reads
  nothing. No such fallback exists: the plugin has exactly three sources — `GET /models`,
  constraint elicitation, and the behavioural image probe — and anything they fail to
  establish is reported `unknown` and left unwritten. The table now says so.
- **Stopped quoting UI labels that do not exist.** The English section presented the
  settings page as `模型配置实测 / Model Config Probe` and its controls as
  `允许探测 / Allow probing` — but the interface ships Chinese labels only, with no
  translation layer. The English text now names the Chinese strings and marks the rest as
  translations.
- Documented the four configuration keys and their defaults (`enabledProviders`,
  `maxRequestsPerScan`, `visionProbe`, `toleranceRatio`), which until now were only
  visible as comments in `cordis.patch.yml`.
- Corrected the image probe's cost: it is ~50 **output** tokens, not ~50 tokens — the
  image's input tokens are billed as well — and recorded that the probe is skipped when
  `/models` already reports image support, while its verdict outranks that self-report.
- Gave the Chinese section the Notes and Tests sections the English one already had, so
  the two halves of the README describe the same thing.

## [0.1.3] — 2026-09-11

### Fixed

- **Never report success when nothing was verified.** When every request failed
  (`fetch failed` — DNS, refused, reset, TLS), the settings page still showed the green
  "配置与实测一致，无需改动" (configuration matches measurement, no changes needed). A
  total failure presented as a clean bill of health is the worst bug this plugin could
  have. Scans now carry a `verification` block with verified/unknown field counts,
  per-model lines state "N unverified", and the client renders three outcomes separately:
  differences found, verified and matching, or nothing verified.
- The HTTP layer keeps `fetch`'s error `cause`. `fetch` throws a constant
  `TypeError('fetch failed')` and hides the real reason — DNS, connection refused, reset,
  TLS — in `cause`; common codes are now translated into plain language.
- Host-supplied peers are marked `peerDependenciesMeta.*.optional`
  (`@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`, `react`). Profiles run with
  `autoInstallPeers: false` and the DSH installation serves those packages at runtime, so
  an install used to end with `[WARN] Issues with peer dependencies found` and
  `pnpm peers check` exiting 1 — reproduced on 0.1.2, gone on 0.1.3.

### Documentation

- The install step now names the profile DSH actually boots. On DSH Desktop that is not
  `web`: the documented command used to create a separate profile the app never loads,
  with exit code 0 and no error afterwards. Current `dsh` builds reject the
  Electron-owned `desktop` profile from the CLI, so the docs also cover installing from
  inside the app, and add a `--dump-config` check plus the note that the CLI does not
  hot-mount.

## [0.1.2] — 2026-09-11

### Fixed

- Read more endpoint error shapes when eliciting constraints, and stop guessing at vision:
  an unparsable limit is reported `unknown` rather than inferred.

## [0.1.1] — 2026-09-11

### Documentation

- Document the npm install route alongside the GitHub one.

## [0.1.0] — 2026-09-11

### Added

- First release. Constraint elicitation for `maxTokens` and `reasoningEfforts` (send an
  illegal value, read the legal range out of the rejection — zero output tokens),
  `GET /models` for `contextWindow`, and a behavioural image probe for `input` support
  that counts randomly generated shapes.
- Audit-and-apply: compare measurement against the current configuration, keep values
  within a 5% comparison tolerance, correct anything past the endpoint's hard limit, and
  write only what has evidence.
- The settings page 模型配置实测, and the agent tools `model_probe_status`,
  `model_probe_scan` and `model_probe_apply`.

[0.1.5]: https://github.com/xiaomao49/dsh-model-probe/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/xiaomao49/dsh-model-probe/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/xiaomao49/dsh-model-probe/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/xiaomao49/dsh-model-probe/compare/v0.1.1...v0.1.2
[0.1.1]: https://www.npmjs.com/package/dsh-model-probe/v/0.1.1
[0.1.0]: https://www.npmjs.com/package/dsh-model-probe/v/0.1.0
