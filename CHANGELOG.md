# Changelog

All notable changes to `dsh-model-probe`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases from 0.1.1 onwards carry a GitHub tag (`v0.1.1`, `v0.1.2`, `v0.1.3`, …); 0.1.0
never got one and links to npm instead. GitHub Releases were first published with 0.1.4,
so the entries below are reconstructed from those tags, the npm publish times and the
commit history.

## [0.1.13] — 2026-09-14

### Changed

- **仅元数据与文档：`lib/` 与 0.1.12 逐字节相同，插件行为完全一致。** 本次发布存在的
  唯一理由是 npm 上的 `0.1.12` tarball 带的是 CHANGELOG 的**首个版本**（内容完整，但
  测试说明写在 `Fixed` 段里，没有按仓库惯例单列 `### Tests`）。已发布版本的 tarball
  无法在不改版本号的前提下替换，所以用一个新版本把三处对齐：npm tarball、仓库 tag、
  GitHub Release 现在都是下面这份规范文本。**已经装了 0.1.12 的不需要升级。**

## [0.1.12] — 2026-09-14

### Fixed

- **两个工具在"有东西可报"的时候反而报错：`model_probe_status` 从来没成功过，
  `model_probe_scan` 只在探针全坏时可用。** 根因不在探测逻辑，而在返回值的形状——
  DSH 的取值边界（`@deepseek-ai/dsh-util-values` 的 `isJsonValue`）把 `undefined`
  判为非法，携带它的对象过不了闸门，工具通道直接抛
  `tool "model_probe_status" returned invalid output: value is not lossless JSON`。
  而 `JSON.stringify` 会静默丢掉 `undefined` 属性，两者语义不一致：本插件照"JSON
  会丢"的直觉写（可选字段直接写进对象），撞上的是"不丢才合格"的判据。
  症状因此完全反直觉 —— 请求全部失败时所有 finding 的 verdict 都是 `unknown`，
  被出口过滤器滤光，对象里一个非法值都没有，工具反而正常；一旦真的取证到字段，
  `limit` / `note` / `from` 之类的可选值带着 `undefined` 出现，工具立刻挂掉。
  **探针坏着的时候工具能用，修好了反而挂。**
  报告来自 issue #1，附了可复现的最小算例与判据实证。
  修法是新增 `compact()`（`lib/scan.js`）在所有跨边界出口统一收口，而不是逐字段
  条件展开——后者每新增一个可选字段就要记得写一次，漏掉一次就是一次线上不可用。
  收口点：`model_probe_status` / `model_probe_scan` / `model_probe_apply` 三个工具，
  以及设置页的**全部** HTTP 响应（在 `send()` 里收一次；客户端边界的判据与工具通道
  是同一个 `isJsonValue`，不只在工具出口收）。
  清洗规则与判据逐条对应：`undefined` 丢键、`NaN`/`±Infinity` 丢键（写成 `null`
  是伪造数据）、`-0` 归一为 `0`、`null` 保留（本插件用 `?? null` 表示"明确无值"）、
  数组项被清洗掉时不留空洞。`__proto__` / `constructor` 用 defineProperty 写入，
  避免普通赋值改写原型。

### Tests

- 168 tests (was 108 before `npm ci`; the two files that only fail without
  devDependencies — `plugin.test.mjs` / `write-path.test.mjs` — are unrelated).
  Two new files, 13 tests:
  - `test/lossless.test.mjs` — uses the plugin's own `describeOps` to produce a *real*
    payload (a newly added `reasoningEfforts` field, so `from` exists with value
    `undefined`) and asserts it fails the gate before compacting, then pins down
    `compact`'s semantics one by one: `null` survives, `NaN`/`±Infinity` are dropped,
    `-0` becomes `0`, arrays keep no holes, `__proto__` does not reach the prototype.
  - `test/tool-boundary.test.mjs` — installs the plugin on a fake ctx and actually
    **executes** all three tools plus four HTTP routes, feeding each return value to the
    host's real `isJsonValue`. The judge is loaded from `@deepseek-ai/dsh-util-values`
    when resolvable and falls back to a line-by-line replica otherwise.
- Verified by counter-proof: removing the outlet compaction turns the status test red
  immediately. The previous 108 tests were all green and still missed this, because they
  asserted business semantics (thresholds, tolerances, the write path) and not one of
  them asserted the **shape** of a return value.

## [0.1.11] — 2026-09-12

### Fixed

- **A correct answer could be read as a wrong one, and two of those turned into "this
  model cannot see images".** Reported from a real scan: the settings page showed
  `deepseek/deepseek-v4.1-flash` as `text / image → text` while the model was, in fact,
  reading images in the very same session. The endpoint was never the problem — the
  answer parser was. When a model describes an image as a numbered list
  (`1. A yellow circle 2. A blue square 3. A yellow circle …`), taking the *first*
  integer picks up the list marker `1`; the count the model actually declared
  (`Therefore, the answer is **3**`) sat at the end of the same string. Measured against
  the live endpoint, this misfired on **9 of 24** probes across two samples (4/14 and
  5/10) — with the fixed parser, 0 of 10 — and two misfires in a row produced the verdict
  "两次换图复核均数错（期望 3），判定为不支持图像输入" — a capability that was
  declared, actually present, and wrongly denied. Because `pi-ai` refuses images before
  attaching them, that verdict permanently disables image input for a model that supports
  it, so the asymmetry here is severe.
  The probe question now pins the answer format (`TOTAL=<digit>` on its own final line),
  and the parser reads, in order: the explicitly declared answer (`TOTAL=`, "the answer
  is", "there are", "答案是"), then the last standalone integer. Reading the first integer
  is never used again.
- **"Miscounted" is no longer evidence of "cannot see".** The old verdict turned two
  wrong counts into `input: text`; a model that can see but counts coloured shapes badly
  looks identical to one that is guessing. This is now decided by a **differential
  probe**: two images that differ *only* in how many target shapes they contain, asking
  for `IMAGE_1=<digit>` / `IMAGE_2=<digit>`. Differing readings prove the answer comes
  from the pixels; identical readings across two different images do not, and the result
  is reported as *unconfirmed* rather than as a denial. Guessing a wrong number can no
  longer flip a declared capability off.
- **A response with no readable number is retried with a new image instead of ending the
  probe.** Reading no digit means "no conclusion from this attempt", not "no vision".

### Tests

- 153 tests (was 149): regressions for the enumerated-answer misread and for the
  `TOTAL=` format, plus the two differential-probe outcomes (readings differ → supported;
  readings identical → unconfirmed). The old test that asserted "two wrong counts → not
  supported" was replaced, since that behaviour was the bug.

## [0.1.10] — 2026-09-12

A review pass over the whole flow after 0.1.9. Four things, all found by re-reading the
code rather than by a failure report.

### Fixed

- **A malformed `probeHeaders` can no longer take the whole policy down with it.** The
  schema was a strict nested dict, so a typo in `settings.yaml` (`probeHeaders: {p1:
  "oops"}`) made the `model-probe` namespace fail to install — which does not just ignore
  that one header, it drops `enabledProviders` too and stops the switches from persisting,
  behind an error message that only talks about schemastery internals. The field is now
  permissive at the schema layer and sanitised entry by entry, which is what the README
  promised all along. The settings path was also bypassing `normalizePolicy` entirely, so
  that promise had only ever held for the composition config.
- **The scan cache records the revision from *before* the scan, not after.** A scan takes
  seconds and several requests; taking the revision at the end would label evidence
  gathered under the old configuration as valid for the new one — and that label is
  exactly what decides whether a write reuses the cache. Taking it at the start can only
  fail safe: re-scan rather than write stale evidence.
- **Writing no longer resolves a credential it will not use.** When the reviewed scan is
  reused nothing is sent, and the credential seam is now only touched on the branch that
  actually makes requests.

### Added

- **Writing shares the scan concurrency gate.** `runApply` called `scanProvider` directly
  when it had to re-probe, so "write while a scan is still running" could fire two rounds
  of billed requests. It now refuses with a clear message instead.

### Documentation

- The README's Use section states where the write's evidence comes from, and the
  `model_probe_apply` tool description now matches what the code does instead of
  requiring a prior scan that it no longer needs.

### Tests

- 149 tests (was 145): malformed `probeHeaders` is dropped without disturbing the rest of
  the policy, the schema no longer throws on it, and the write path refuses to re-probe
  while a scan is in flight.

## [0.1.9] — 2026-09-12

### Fixed

- **「确认写入」不再报「已修正 0 处」。** The apply path re-ran the scan with the vision
  probe deliberately disabled — its comment claimed the previous scan's conclusion would
  be reused, but nothing ever carried it over. `input` is established **only** by that
  probe, so the field could never be written: the page listed `input → 实测支持图像`
  and pressing confirm reported zero changes, with no error to explain it.

  Apply now writes **the scan you just reviewed**, cached per provider together with the
  `llm-pi-ai` revision it was taken at. Re-probing was avoided for two reasons, and both
  still hold: the image probe costs output tokens, and a behavioural probe can return a
  different verdict the second time (image conclusions have been observed flipping), so
  re-scanning can write something other than what was on screen. When no reviewed scan is
  available — a fresh process, or the agent calling `model_probe_apply` directly — apply
  now runs a **complete** scan including the vision probe instead of silently dropping the
  field. A changed revision invalidates the cache, because evidence is only valid for the
  configuration it was taken against. The response reports which it used
  (`evidence: reviewed-scan | fresh-scan`).

### Changed

- **The startup line no longer contradicts itself.** It used to print
  `探测当前开启：cc-goat, opencode-go` and, one line later, that it could not read the
  provider list at all — both true, together nonsense. When the layer was not readable at
  load time it now says so in the same sentence and calls the list what it is: the
  whitelist, uncross-checked.

### Tests

- 145 tests (was 142): applying reuses the reviewed scan (the vision-only field lands, and
  no second image request goes out), applying without one probes afresh, and a changed
  revision invalidates the cache.

## [0.1.8] — 2026-09-12

### Fixed

- **The startup diagnostics no longer claim your providers were deleted.** `apply()` reads
  settings while the `llm-pi-ai` namespace is usually still unregistered, so
  `readPiSection` falls back to `{ providers: {} }`. The stale-provider check added in
  0.1.6 read that empty list as "every whitelisted provider is gone" and printed
  `探测白名单里有 2 个 provider 已不在 llm-pi-ai 配置中：cc-goat, opencode-go` on a
  configuration that was completely fine. The intersection is now only computed when the
  raw user layer was actually read; otherwise the whitelist is passed through untouched
  and the log says it could not read the layer this time. The live settings page was
  never affected — it re-reads on every open — but a diagnostic that invents deletions is
  worse than no diagnostic.

### Tests

- 142 tests (was 140): one pins the unreadable case (no stale claim, whitelist
  preserved), one pins the readable case (a genuinely deleted provider is still
  reported).

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
