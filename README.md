# dsh-model-probe

**English** | [中文](#中文说明)

[![CI](https://github.com/xiaomao49/dsh-model-probe/actions/workflows/ci.yml/badge.svg)](https://github.com/xiaomao49/dsh-model-probe/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dsh-model-probe.svg)](https://www.npmjs.com/package/dsh-model-probe)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4d6bfe)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-4d6bfe)](https://github.com/topics/dsh-plugin)

Audit and correct model capability declarations for `llm-pi-ai` providers in
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — by asking the
endpoint itself instead of trusting a knowledge base.

## Why

A mis-declared model costs you silently. Two real cases this plugin was built from:

- **`maxTokens` beyond the endpoint's limit.** A model declared `maxTokens: 384000`
  against a gateway whose legal range was `[1, 131072]`. Nothing rejects the config —
  the plugin loads, the model shows up in the picker — but every request carrying that
  cap fails with HTTP 400.
- **A capability guessed from a catalog.** The bundled pi-ai catalog listed the
  DeepSeek V4 series as text-only. Probing the actual gateway showed both models
  read images correctly, including counting shapes in a generated test image.

Filling in missing fields is the easy half. Noticing that a field already has a
**wrong** value is the half that matters — a filler skips any field that has a value.

## How it gets its answers

Five layers, strongest evidence first. Every conclusion carries its source and a
confidence label.

| Layer | Method | Fields | Cost |
| --- | --- | --- | --- |
| 1 | `GET /models` — what the endpoint says about itself | `contextWindow`, sometimes modalities | 1 request |
| 2 | **Constraint elicitation** — send a deliberately illegal value, read the legal range out of the error | `maxTokens`, `reasoningEfforts` | **0 output tokens** |
| 3 | **Behavioural probe** — a randomly generated image, count the shapes | `input` (image support) | ~50 tokens |
| 4 | Bisection / enumeration when layer 2 yields no readable constraint | as layer 2 | few tokens |
| 5 | Nothing readable — report `unknown` and **do not write** | — | 0 |

Layer 2 is the part no other plugin does. Two real error bodies it parses:

```
Invalid max_tokens value, the valid range of max_tokens is [1, 393216]
The max_tokens parameter is illegal.：限制数值范围[1,131072]
Invalid option: expected one of "low"|"medium"|"high"|"xhigh"|"max"
```

The request is rejected, so no tokens are generated — the endpoint simply tells you
its own limits. Layer 3 exists because OCR-style gateways answer "what word is in this
image" without any real vision; counting coloured shapes cannot be faked that way.

## Install

> **Pass the profile name your DSH actually boots.** An install into any other name
> succeeds, exits 0, writes its dependency *and* its `dsh.profile.bundles` entry, and is
> never loaded. Nothing reports it: the only trace is a single stderr line
> `dsh: initialized profile web at …` for a profile you never asked to create.

Read the active profile *before* installing:

| Host | Active profile |
| --- | --- |
| DSH Desktop (Electron) | `"active"` in `profile-selection/state.json` under the app's user-data directory — on Windows `%APPDATA%\DSH Desktop\profile-selection\state.json` |
| `dsh` CLI / web | the name you pass to `dsh --profile <name>` (the shipped `web` profile for `dsh web`) |

**On DSH Desktop the answer is not `web`.** The app owns the profile named `desktop`,
and its in-app plugin market installs into that profile and hot-mounts it — so
`dsh plugin --profile web …` builds a *separate* profile the app never boots. Current
`dsh` builds refuse to manage the Electron-owned profile from the command line
(`profile "desktop" is managed exclusively by the Electron application`), so on those
builds install from inside the app. Older builds that still accept `--profile desktop`
are the ones where that name is the right one to use.

Then install — from npm (prebuilt, so the install skips the `allowBuilds`
build-approval step):

```sh
dsh plugin --profile web add dsh-model-probe
```

or from GitHub:

```sh
dsh plugin --profile web add github:xiaomao49/dsh-model-probe
```

Check where the layer landed — it appears in the composed tree only once the profile is
both installed and booted:

```sh
dsh --profile web --dump-config | grep model-probe      # macOS / Linux
dsh --profile web --dump-config | findstr model-probe   # Windows
```

`- id: model-probe` means the layer is in place. No output means you are inspecting a
different profile from the one you installed into — and if that name is not the active
profile either, nothing will ever load it.

Then **fully quit and restart DSH**. The in-app market hot-mounts and logs
`{"event":"hot-mount"}` into `<profile>/.dsh-market/log.ndjson`; the CLI does not — it
only reconciles the profile's dependencies and `dsh.profile.bundles`, and tells you
nothing about needing a restart, so the plugin shows up after one. The package is plain
JavaScript with no build step, so either route installs without a build approval.

### The peer-dependency warning (0.1.2 and earlier)

Older versions made pnpm print this during the install:

```
[WARN] Issues with peer dependencies found. Run "pnpm peers check" to list them.
```

`pnpm peers check` then exited 1, listing `@deepseek-ai/dsh-tools`,
`@deepseek-ai/schemastery` and `react` as missing — which reads as "the install is
broken" to anyone seeing it for the first time. It never was. Profiles run with
`autoInstallPeers: false`, and those packages are supplied at runtime by the DSH
installation itself, never by the profile: every plugin in a working profile reports the
same thing. **0.1.3 marks them `peerDependenciesMeta.*.optional`**, so a fresh install is
silent and `pnpm peers check` exits 0. If you still see the warning — an older pinned
version, or a profile that has not been re-resolved — it remains informational.

### If you installed before 0.1.3

0.1.2 and earlier could not tell "everything matches" from "nothing was measured": when
every request failed (`fetch failed` — DNS, refused, reset, TLS), the settings page still
showed the green *configuration matches measurement, no changes needed*
(配置与实测一致，无需改动). A total failure presented as a clean bill of health is the
worst bug this plugin can have. **0.1.3** adds a `verification` block, per-model
*N unverified* lines, and the real cause behind `fetch failed`. Upgrade with:

```sh
dsh plugin --profile web add dsh-model-probe@latest
```

## Use

**Settings → 模型配置实测 / Model Config Probe**

1. Switch on **允许探测 / Allow probing** for a provider. Probing is off by default
   and enabled per provider, because it sends real requests to that endpoint.
2. **扫描 / Scan** — read-only. Shows every field's current value, measured value,
   evidence source and confidence.
3. **确认写入 / Apply** — backs up `settings.yaml`, then writes through
   `settings.mutate` with an optimistic lock.

Three tools are also registered for the agent: `model_probe_status`,
`model_probe_scan`, `model_probe_apply`.

### Comparison tolerance

Numeric fields use a **5% comparison tolerance**: when the configured value already
exists and is within 5% of the measured value, it is left alone; beyond that it is
overwritten with the measured value. This avoids churn from unit conventions
(1M vs 1MiB) and deliberate safety margins.

The tolerance never softens the out-of-range check: a value past the endpoint's hard
limit is corrected regardless of how small the gap is, because such a request is
rejected outright.

### Safety rules

- Probing is off by default; the current state is stated on the settings page.
- Scan is read-only. Writing requires an explicit confirmation, checked twice.
- `settings.yaml` is backed up before every write; a rejected write removes its own
  backup so a failed attempt leaves no clutter.
- Credentials are resolved per request through the credential seam — never cached,
  never logged, never returned over the settings API.
- Writes read the **raw user layer** (`settings.describe().user`), not the resolved
  value, so schema defaults are never baked into your configuration file.
- A field with no evidence is reported as `unknown` and left untouched.

## Notes

- Provider routes are read from the `llm-pi-ai` settings namespace.
- `openai-completions` and `anthropic-messages` are supported for probing.
- The image probe uses a PNG synthesized at runtime (Node's `zlib` plus a small
  CRC32), so the package has no image dependencies.
- Endpoint error wording varies. When a constraint cannot be parsed the field is
  reported as `unknown` rather than guessed.

## Tests

```sh
npm test
```

106 tests, including regressions that pin the reporting rules: an all-failed run must
never render as "nothing to change", and a partially verified run must state how many
fields were actually measured. The fixtures include verbatim error bodies captured from
a real gateway, and a byte-level reimplementation of the settings path-op semantics, so
writes are validated against the real schema before they are considered correct.

## License

MIT

---

## 中文说明

向端点本身取证，审计并修正 `llm-pi-ai` 供应商的模型能力声明。

### 为什么需要它

配错的模型不会报错，只会静默地失败。两个真实案例：

- **`maxTokens` 超过端点上限。** 某模型声明 `maxTokens: 384000`，而网关的合法范围是
  `[1, 131072]`。配置能加载、模型在选择器里正常显示，但每个带上这个上限的请求都会
  被 HTTP 400 拒绝。
- **能力来自目录的猜测。** pi-ai 内置目录把 DeepSeek V4 系列标为纯文本，实测该网关
  下两个模型都能正确读图——包括数出生成图片里的图形数量。

补全缺失字段是容易的一半；发现某个字段**已经有值但是错的**才是关键——填充器看到字段
有值就跳过了。

### 取证方式

五层阶梯，证据强的优先。每个结论都带来源与置信度。

| 层级 | 手段 | 字段 | 成本 |
| --- | --- | --- | --- |
| 1 | `GET /models`，端点自述 | `contextWindow`，有时含模态 | 1 次请求 |
| 2 | **约束取证**：故意发非法值，从报错里读出合法范围 | `maxTokens`、`reasoningEfforts` | **0 输出 token** |
| 3 | **行为实证**：随机生成图片，数图形 | `input`（图像能力） | 约 50 token |
| 4 | 第 2 层读不出约束时，二分/枚举探测 | 同第 2 层 | 少量 token |
| 5 | 都读不出 → 标 `unknown`，**不写入** | — | 0 |

第 2 层是其它插件没做的部分。它能解析的真实错误体：

```
Invalid max_tokens value, the valid range of max_tokens is [1, 393216]
The max_tokens parameter is illegal.：限制数值范围[1,131072]
Invalid option: expected one of "low"|"medium"|"high"|"xhigh"|"max"
```

请求被拒绝，因此没有 token 被生成——端点只是告诉了你它自己的限制。第 3 层存在的原因：
OCR 型网关能答对「图里是什么字」却没有真正的视觉能力，而数彩色图形无法这样蒙对。

### 安装

> **`--profile` 必须写你的 DSH 实际启动的那个档位。** 装进别的名字一样会成功：退出码 0、
> 依赖与 `dsh.profile.bundles` 都写好了，然后永远不会被加载。全程没有任何报错可查——唯一
> 的痕迹是 stderr 上一行 `dsh: initialized profile web at …`，替你去创建一个你从没打算
> 要的档位。

安装前先确认当前活动的档位：

| 宿主 | 活动档位怎么看 |
| --- | --- |
| DSH Desktop（Electron） | 应用 user-data 目录下 `profile-selection/state.json` 的 `"active"`（Windows 为 `%APPDATA%\DSH Desktop\profile-selection\state.json`） |
| `dsh` CLI / web | 你 `dsh --profile <name>` 里传的那个名字（`dsh web` 即内置的 `web` 档位） |

**在 DSH Desktop 上，答案不是 `web`。** 应用独占名为 `desktop` 的档位，它内置的插件市集
就是装进这个档位并热挂载的——所以 `dsh plugin --profile web …` 建出的是应用永远不会启动
的另一个档位。较新的 `dsh` 直接从命令行拒绝管理这个 Electron 档位——`profile "desktop" is
managed exclusively by the Electron application`——这类版本请改在应用内（插件市集）安装；
仍然是老版本、接受 `--profile desktop` 的，那个名字才是对的。

然后安装——从 npm 装（预构建，免去 `allowBuilds` 构建授权）：

```sh
dsh plugin --profile web add dsh-model-probe
```

或从 GitHub 装：

```sh
dsh plugin --profile web add github:xiaomao49/dsh-model-probe
```

确认这一层落在哪个档位上——只有「装好且会被启动」的档位，组合树里才看得到它：

```sh
dsh --profile web --dump-config | grep model-probe      # macOS / Linux
dsh --profile web --dump-config | findstr model-probe   # Windows
```

出现 `- id: model-probe` 说明层已就位；没有任何输出，说明你查的档位和你装进去的档位不是
同一个——而只要它不是活动档位，这个插件就永远不会被加载。

然后**完全退出并重启 DSH**。应用内市集是热挂载的，会在
`<档位>/.dsh-market/log.ndjson` 里记 `{"event":"hot-mount"}`；CLI 不热挂载——它只负责
协调档位的依赖与 `dsh.profile.bundles`，也完全不提示需要重启，所以插件要重启后才
出现。包是纯 JavaScript、无构建步骤，两种方式都不需要构建授权。

### 那条 peer 警告（0.1.2 及更早）

老版本安装时 pnpm 会打印：

```
[WARN] Issues with peer dependencies found. Run "pnpm peers check" to list them.
```

随后 `pnpm peers check` 退出码为 1，列出 `@deepseek-ai/dsh-tools`、
`@deepseek-ai/schemastery`、`react` 缺失——第一次看到的人很容易当成装坏了。其实从来不是。
profile 跑在 `autoInstallPeers: false` 下，而这些包由 DSH 本体在运行时供给，profile 层
本就不该安装它们：任何一个能正常工作的 profile 报的都是同一批。**0.1.3 已把它们标为
`peerDependenciesMeta.*.optional`**，因此全新安装不会再打印警告，`pnpm peers check` 退出
码为 0。如果你仍然看到这条警告——装的是被 pin 住的老版本，或者 profile 还没重新解析——
它依然只是信息性的。

### 如果你装的是 0.1.3 之前的版本

0.1.2 及更早无法区分「全都一致」和「什么都没测到」：所有请求都失败（`fetch failed`——
DNS、连接被拒、连接重置、TLS）时，设置页依然显示绿色的「配置与实测一致，无需改动」。
把彻底失败展示成一张健康证明，正是这个插件最不该犯的错。**0.1.3** 增加了 `verification`
区块、逐模型的「N 个未取证」提示，以及 `fetch failed` 背后的真实原因。升级：

```sh
dsh plugin --profile web add dsh-model-probe@latest
```

### 使用

**设置 → 模型配置实测**

1. 为某个 provider 打开「允许探测」。探测默认关闭、逐 provider 开启，因为它会向该端点
   发真实请求。
2. **扫描**——只读。列出每个字段的当前值、实测值、证据来源与置信度。
3. **确认写入**——先备份 `settings.yaml`，再通过 `settings.mutate` 带乐观锁写入。

同时为 Agent 注册了三个工具：`model_probe_status`、`model_probe_scan`、
`model_probe_apply`。

### 比较容差

数值字段采用 **5% 比较容差**：当前值已有值且与实测值差距在 5% 以内时保持不动，超过
才覆盖为实测值。这样可避免为单位约定（1M 与 1MiB）或刻意留出的安全余量制造无谓改动。

容差不会放松越界判定：越过端点硬约束的值无论差距多小都必须修正，因为那种请求会被直接
拒绝。

### 安全守则

- 探测默认关闭，设置页上如实显示当前状态。
- 扫描只读；写入需要显式确认，且校验两次。
- 每次写入前备份 `settings.yaml`；写入被拒时删除自己的备份，失败的尝试不留垃圾。
- 凭据按次通过凭据 seam 解析——不缓存、不写日志、不经设置页 API 返回。
- 写入读取**原始用户层**（`settings.describe().user`）而非解析值，schema 默认值绝不会
  被固化进你的配置文件。
- 没有证据的字段报告为 `unknown` 并保持不动。
