# Changelog

All notable changes to `dsh-model-probe`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases from 0.1.1 onwards carry a GitHub tag (`v0.1.1`, `v0.1.2`, `v0.1.3`, …); 0.1.0
never got one and links to npm instead. GitHub Releases were first published with 0.1.4,
so the entries below are reconstructed from those tags, the npm publish times and the
commit history.

## [0.1.7] — 2026-09-12

### Added

- **`model-probe.probeHeaders` — extra headers for probe requests only.** Some gateways
  require a header beyond the API key (`https://opencode.ai/zen/go/v1` rejects every
  request without `x-opencode-session`), and until now the only place to put it was
  `llm-pi-ai.providers.<id>.headers`. That is the wrong place: DSH sends those on every
  real model call too, so a static entry there silently **disables** any plugin that
  derives the header per conversation — the static value wins, and every conversation
  collapses into one routing/cache-affinity bucket. This field lives in the plugin's own
  namespace, so probe requests get their header and DSH's calls are untouched.

  ```yaml
  model-probe:
    probeHeaders:
      opencode-go:
        x-opencode-session: dsh-model-probe
  ```

  Same-name precedence: an entry here wins over `llm-pi-ai`'s, because it is what you
  specified for probing.

### Security

- **`probeHeaders` values are never returned.** They may contain credentials, so the
  status payload and both HTTP routes report only *which providers* have probe headers
  (`policy.probeHeaderProviders`) — never a name or a value. A regression test asserts
  that a configured value appears in no tool result and no HTTP response.

### Notes

- Malformed `probeHeaders` shapes are dropped rather than rejected: a typo in one header
  must not stop the plugin from loading or take the other providers down with it.
- Toggling a switch still writes through `settings.update` (a merge), so a hand-written
  `probeHeaders` survives. A regression test now pins that the plugin never calls
  `settings.replace`.

### Tests

- 140 tests (was 132): header merge and precedence through a real scan, the
  "only the named provider" boundary, the no-leak guarantee, shape sanitisation, and the
  merge-not-replace write path.

## [0.1.6] — 2026-09-12

Three of these four come from one real report: a provider that had been deleted from
the model configuration still showed up as "probing enabled", and a second provider
could not be probed at all — every field came back `unknown`.

### Fixed

- **A deleted provider no longer appears in the settings page.** `enabledProviders` is a
  persisted allowlist, while the provider list comes from `llm-pi-ai`; removing a
  provider there left its name in the allowlist, so the page announced
  `当前已开启探测：cc-goat、op-go、op-zen` for a provider that no longer existed — and,
  because a deleted provider has no card, there was no switch to turn it off. The
  effective set is now the allowlist **intersected with the providers that exist**, the
  leftovers are reported separately in the status payload, and the next switch change
  writes the narrowed list. The raw value is deliberately left alone on load: a provider
  removed temporarily and added back keeps its authorisation.
- **Provider headers are forwarded to every probe request.** `readProvider` had been
  reading `profile.headers` since the first release and nothing ever sent them, so a
  gateway that requires a header beyond the API key could not be probed at all. Measured
  case: `https://opencode.ai/zen/go/v1` (Console Go) rejects any request without
  `x-opencode-session` — every field came back `unknown`, which reads as "this endpoint
  cannot be measured" when the real cause is one missing header. DSH's `llm-pi-ai` sends
  these headers itself, so the probe now matches what actually runs.
- **`Input should be less than or equal to N` is now parsed.** A sixth pattern for the
  Pydantic / FastAPI wording, which has no brackets, no "must be between" and no `>` —
  the first five patterns all read it as "no range given". Measured on the same gateway:
  `glm-5.3-flash` reports `10,000,000`. The pattern only fires when the text names the
  field being asked about, so a bound on some other field is still reported `unknown`
  rather than written into your configuration.
- **The last value of an enum list is no longer dropped when prose follows it.** Rust
  serde appends `` at line 1 column 66 `` after the accepted values; cleaning the last
  token as a whole left it equal to nothing, so `max` silently disappeared from the
  reported levels.
- **`none` is recognised as the wire spelling of "no thinking".** The same gateway
  rejects `off` and accepts `none`. Reading the list literally produced the conclusion
  "this model cannot turn thinking off" — the opposite of the truth. The level is now
  reported as `off`, and the note says which wire value to declare.

### Added

- **Transport-level retries.** A gateway that resets connections intermittently
  (`ECONNRESET`) used to cost an entire evidence source: one reset on the listing call
  and every model lost its `contextWindow`. The listing is retried twice and the
  constraint-elicitation calls once; retries happen only when the connection never
  completed, never when a response was received — a 400 is the evidence, not a failure.
  `ETIMEDOUT` and certificate errors are not retried.

### Tests

- 132 tests (was 106), including a fetch-stub suite that pins both sides of the retry
  boundary, a header-forwarding suite, and the new parser cases against captured error
  bodies.

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
