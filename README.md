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

From npm — prebuilt, so the install skips the `allowBuilds` build-approval step:

```sh
dsh plugin --profile web add dsh-model-probe
```

From GitHub:

```sh
dsh plugin --profile web add github:xiaomao49/dsh-model-probe
```

Then restart DSH. The package is plain JavaScript with no build step, so either
route installs without a build approval.

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

91 tests. The fixtures include verbatim error bodies captured from a real gateway,
and a byte-level reimplementation of the settings path-op semantics, so writes are
validated against the real schema before they are considered correct.

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

从 npm 安装——预构建，免去 `allowBuilds` 构建授权：

```sh
dsh plugin --profile web add dsh-model-probe
```

从 GitHub 安装：

```sh
dsh plugin --profile web add github:xiaomao49/dsh-model-probe
```

然后重启 DSH。包是纯 JavaScript、无构建步骤，两种方式都不需要构建授权。

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
