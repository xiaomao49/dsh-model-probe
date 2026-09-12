/**
 * dsh-model-probe — 客户端（设置页）。
 *
 * 交互流程刻意设计成"扫描 → 看证据 → 确认写入"三步，而不是一键自动改配置：
 *   - 扫描是只读的，随时可跑，把每个字段的当前值、实测值、证据来源与置信度摆出来；
 *   - 写入必须点确认，且宿主侧还有第二道 confirm 闸；
 *   - 探测开关逐 provider 独立，因为探测会发真实计费请求。
 *
 * 这个页面存在的理由：越界这种问题（如某个模型的 maxTokens 超过端点上限，
 * 导致每次请求都失败）在纯文本配置里完全看不出来，必须被摆到眼前。
 */

window.__ModuleLoader__.load({
  id: 'dsh-model-probe',
  factory: (require) => {
    const React = require('react')
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const API = '/api/model-probe'

    const CSS = `
.mp-root{display:flex;flex-direction:column;gap:14px;padding:4px;max-width:820px}
.mp-head{display:flex;flex-direction:column;gap:4px}
.mp-title{font-size:15px;font-weight:600}
.mp-sub{font-size:12px;opacity:.65;line-height:1.6}
.mp-provider{border:1px solid rgba(128,128,128,.22);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:10px}
.mp-prow{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.mp-pname{font-weight:600;font-size:13px}
.mp-url{font-size:11px;opacity:.55;font-family:monospace}
.mp-spacer{flex:1}
.mp-btn{height:28px;padding:0 12px;border-radius:7px;border:1px solid rgba(128,128,128,.3);background:transparent;color:inherit;cursor:pointer;font-size:12px}
.mp-btn:hover:not(:disabled){background:rgba(128,128,128,.14)}
.mp-btn:disabled{opacity:.4;cursor:not-allowed}
.mp-btn.primary{border-color:rgba(80,140,255,.55);background:rgba(80,140,255,.16)}
.mp-btn.danger{border-color:rgba(255,90,90,.5);background:rgba(255,90,90,.14)}
.mp-toggle{display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;user-select:none}
.mp-models{font-size:12px;opacity:.7;line-height:1.7}
.mp-model{padding:6px 0;border-top:1px solid rgba(128,128,128,.14)}
.mp-mname{font-family:monospace;font-size:12px}
.mp-find{display:flex;gap:8px;align-items:baseline;padding:3px 0;font-size:12px;line-height:1.6}
.mp-tag{flex:none;min-width:52px;text-align:center;border-radius:5px;padding:1px 6px;font-size:11px;border:1px solid transparent}
.mp-tag.ok{background:rgba(60,180,110,.16);border-color:rgba(60,180,110,.4)}
.mp-tag.out{border-color:rgba(255,90,90,.6);background:rgba(255,90,90,.18);font-weight:600}
.mp-tag.mis{background:rgba(240,180,60,.16);border-color:rgba(240,180,60,.4)}
.mp-tag.miss{background:rgba(80,140,255,.16);border-color:rgba(80,140,255,.4)}
.mp-tag.unk{background:rgba(128,128,128,.14);border-color:rgba(128,128,128,.3)}
.mp-vals{font-family:monospace;font-size:11px;opacity:.9;word-break:break-all}
.mp-note{font-size:11px;opacity:.7;padding-left:60px;line-height:1.6}
.mp-ev{font-size:11px;opacity:.5;padding-left:60px}
.mp-msg{font-size:12px;padding:8px 10px;border-radius:7px;line-height:1.6;white-space:pre-wrap}
.mp-msg.info{background:rgba(80,140,255,.12)}
.mp-msg.good{background:rgba(60,180,110,.12)}
.mp-msg.bad{background:rgba(255,90,90,.14)}
.mp-plan{border:1px solid rgba(240,180,60,.4);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:6px}
.mp-plan-title{font-size:12px;font-weight:600}
.mp-op{font-family:monospace;font-size:11px;opacity:.9;word-break:break-all}
.mp-empty{font-size:12px;opacity:.55;padding:10px 0}
.mp-warn{font-size:11px;opacity:.7;line-height:1.6}
`

    const CSS_ID = 'dsh-model-probe/styles.css'
    if (typeof document !== 'undefined') {
      const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_ID)}]`)
      if (existing === null) {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-model-probe'
        tag.dataset.pluginCss = CSS_ID
        tag.textContent = CSS
        document.head.appendChild(tag)
      }
    }

    const VERDICT_LABEL = {
      ok: { text: '正常', cls: 'ok' },
      'out-of-range': { text: '越界', cls: 'out' },
      mismatch: { text: '不符', cls: 'mis' },
      missing: { text: '缺失', cls: 'miss' },
      unknown: { text: '未知', cls: 'unk' },
    }

    const FIELD_LABEL = {
      contextWindow: '上下文窗口',
      maxTokens: '输出上限',
      reasoningEfforts: '推理档位',
      input: '输入模态',
    }

    /** 极简 fetch 包装：统一错误处理，避免每个调用点重复写。 */
    async function call(path, options) {
      const res = await fetch(`${API}${path}`, {
        method: options === undefined ? 'GET' : 'POST',
        headers: options === undefined ? undefined : { 'content-type': 'application/json' },
        body: options === undefined ? undefined : JSON.stringify(options),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.ok === false) {
        throw new Error(String(data?.error ?? `HTTP ${res.status}`))
      }
      return data
    }

    /** 把值渲染成紧凑的单行文本。 */
    function fmt(value) {
      if (value === undefined) return '—'
      if (Array.isArray(value)) return value.join(' / ')
      if (value !== null && typeof value === 'object') {
        return Object.entries(value)
          .map(([k, v]) => (v === null ? `${k}（留空）` : `${k}`))
          .join(' / ')
      }
      return String(value)
    }

    function ModelProbeSettings() {
      const [status, setStatus] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [message, setMessage] = React.useState(null)
      // 扫描结果按 provider 存：允许对比多次扫描，而不是互相覆盖。
      const [scans, setScans] = React.useState({})

      const refresh = React.useCallback(async () => {
        try {
          setStatus(await call('/status'))
        } catch (error) {
          setMessage({ kind: 'bad', text: `读取状态失败：${error.message}` })
        }
      }, [])

      React.useEffect(() => {
        refresh()
      }, [refresh])

      const setPolicy = async (patch) => {
        try {
          setStatus(await call('/policy', patch))
          setMessage(null)
        } catch (error) {
          setMessage({ kind: 'bad', text: error.message })
        }
      }

      const toggleProbe = (providerId, enabled) => {
        const current = status?.policy?.enabledProviders ?? []
        const next = enabled ? [...new Set([...current, providerId])] : current.filter((x) => x !== providerId)
        return setPolicy({ enabledProviders: next })
      }

      const runScan = async (providerId) => {
        setBusy(`scan:${providerId}`)
        setMessage(null)
        try {
          const result = await call('/scan', { provider: providerId })
          setScans((prev) => ({ ...prev, [providerId]: result }))

          // 三种结果必须说三种话。把它们混成一句"未发现需要修正的字段"、
          // 再配绿色背景，是实际出过的 bug：端点全部不可达时界面显示成功。
          if (result.verifiedNothing === true) {
            setMessage({
              kind: 'bad',
              text:
                `${providerId}：本次未能取证 —— 请求全部失败（${result.scan?.listingReason ?? '端点不可达'}）。` +
                '这并不代表配置正确。请检查网络或端点后重试。',
            })
          } else if (result.opCount === 0) {
            setMessage({
              kind: 'good',
              text: `${providerId}：已取证 ${result.verification?.verifiedFields ?? 0} 个字段，未发现需要修正的项。`,
            })
          }
        } catch (error) {
          setMessage({ kind: 'bad', text: `${providerId} 扫描失败：${error.message}` })
        } finally {
          setBusy('')
        }
      }

      const applyScan = async (providerId) => {
        setBusy(`apply:${providerId}`)
        setMessage(null)
        try {
          const result = await call('/apply', { provider: providerId, confirm: true })
          const backup = result.backup === undefined ? '' : `\n已备份：${result.backup}`
          setMessage({
            kind: 'good',
            text: `${providerId}：已修正 ${result.applied} 处。${backup}`,
          })
          // 写入后旧结论失效，清掉以免误读。
          setScans((prev) => {
            const next = { ...prev }
            delete next[providerId]
            return next
          })
          await refresh()
        } catch (error) {
          setMessage({ kind: 'bad', text: `${providerId} 写入失败：${error.message}` })
        } finally {
          setBusy('')
        }
      }

      if (status === null) {
        return React.createElement('div', { className: 'mp-root' }, React.createElement('div', { className: 'mp-empty' }, '加载中…'))
      }

      const providers = status.providers ?? []
      const enabledCount = (status.policy?.enabledProviders ?? []).length
      // 已从模型配置中删除、但仍留在开关白名单里的 provider。它们不出现在
      // 下面的卡片里（卡片来自真实 provider 列表），所以要在提示行里交代。
      const staleCount = (status.policy?.staleProviders ?? []).length

      return React.createElement(
        'div',
        { className: 'mp-root' },
        React.createElement(
          'div',
          { className: 'mp-head' },
          React.createElement('div', { className: 'mp-title' }, '模型配置实测'),
          React.createElement(
            'div',
            { className: 'mp-sub' },
            '向端点取证，检查每个模型的能力声明是否与端点实际接受的一致。',
            React.createElement('br'),
            '能发现纯文本配置看不出来的问题——例如某个模型的输出上限超过了端点的合法范围，导致每次请求都失败。',
          ),
        ),

        message !== null
          ? React.createElement('div', { className: `mp-msg ${message.kind}` }, message.text)
          : null,

        React.createElement(
          'div',
          { className: 'mp-warn' },
          '探测会向对应端点发送真实请求（可能计费）。取证请求因故意传非法值而被端点拒绝，通常不产生输出费用；图像能力实证是唯一产生输出的环节。',
          React.createElement('br'),
          // 如实反映当前状态，而不是笼统地说"默认关闭"——用户已经开着某个
          // provider 时，那句话会让人以为实际没开。
          enabledCount > 0
            ? `当前已开启探测：${(status.policy?.enabledProviders ?? []).join('、')}`
            : '探测当前全部关闭，需逐 provider 开启。',
          // 白名单里留着已删除的 provider 时说明一句：否则用户会觉得"我删了它
          // 怎么还在这儿"，或者反过来疑惑它为什么消失了。
          staleCount > 0
            ? React.createElement(
                'span',
                null,
                React.createElement('br'),
                `另有 ${staleCount} 个已从模型配置中删除的 provider 仍在开关白名单里（${(status.policy?.staleProviders ?? []).join('、')}），已按不存在处理，改动任一开关时会自动清掉。`,
              )
            : null,
          React.createElement('br'),
          status.policyPersisted === true
            ? '开关改动会持久化到 settings.yaml。'
            : '注意：本次运行中开关无法持久化，重启后会重置为关闭。',
        ),

        // 写入被停用时必须显眼地说明原因，否则用户会奇怪"为什么扫描能用、
        // 确认写入点了没反应"。
        status.writable === false
          ? React.createElement(
              'div',
              { className: 'mp-msg bad' },
              `配置修正已停用：${status.writeBlockedReason ?? '无法读取原始用户层'}`,
            )
          : null,

        React.createElement(
          'label',
          { className: 'mp-toggle' },
          React.createElement('input', {
            type: 'checkbox',
            checked: status.policy?.visionProbe !== false,
            onChange: (e) => setPolicy({ visionProbe: e.target.checked }),
          }),
          '启用图像能力实证（唯一产生输出 token 的环节）',
        ),

        providers.length === 0
          ? React.createElement('div', { className: 'mp-empty' }, '未发现 llm-pi-ai provider。请先在「模型」设置页添加提供商。')
          : providers.map((p) => renderProvider(p, { busy, scans, runScan, applyScan, toggleProbe })),
      )
    }

    function renderProvider(p, { busy, scans, runScan, applyScan, toggleProbe }) {
      const scan = scans[p.id]
      const scanning = busy === `scan:${p.id}`
      const applying = busy === `apply:${p.id}`
      const disabled = busy !== ''

      const children = [
        React.createElement(
          'div',
          { className: 'mp-prow', key: 'head' },
          React.createElement('span', { className: 'mp-pname' }, p.displayName ?? p.id),
          React.createElement('span', { className: 'mp-url' }, `${p.id} · ${p.modelCount} 个模型`),
          React.createElement('span', { className: 'mp-spacer' }),
          React.createElement(
            'label',
            { className: 'mp-toggle' },
            React.createElement('input', {
              type: 'checkbox',
              checked: p.probeEnabled === true,
              disabled: disabled,
              onChange: (e) => toggleProbe(p.id, e.target.checked),
            }),
            '允许探测',
          ),
          React.createElement(
            'button',
            {
              className: 'mp-btn primary',
              disabled: disabled || p.probeEnabled !== true || p.modelCount === 0,
              onClick: () => runScan(p.id),
              title: p.probeEnabled === true ? '扫描并比对' : '需要先开启「允许探测」',
            },
            scanning ? '扫描中…' : '扫描',
          ),
        ),
      ]

      if (p.baseURL !== undefined) {
        children.push(React.createElement('div', { className: 'mp-url', key: 'url' }, p.baseURL))
      }

      if (scan === undefined) {
        children.push(
          React.createElement(
            'div',
            { className: 'mp-models', key: 'models' },
            p.models.map((m) =>
              React.createElement(
                'div',
                { className: 'mp-model', key: m.id },
                React.createElement('span', { className: 'mp-mname' }, m.id),
                React.createElement(
                  'span',
                  null,
                  `  上下文 ${fmt(m.contextWindow)} · 输出上限 ${fmt(m.maxTokens)} · 档位 ${
                    m.hasEfforts ? '已声明' : '未声明'
                  }`,
                ),
              ),
            ),
          ),
        )
      } else {
        // busy / applyScan 必须显式传入：renderScan 是外层函数，够不到组件内部的
        // 局部状态。早期版本在这里漏了参数，导致扫描后渲染时抛 ReferenceError，
        // 整个设置面板白屏。
        children.push(...renderScan(scan, p, { busy, applyScan }))
      }

      return React.createElement('div', { className: 'mp-provider', key: p.id }, children)
    }

    function renderScan(scan, p, { busy, applyScan }) {
      const nodes = []
      const s = scan.scan
      // 防御：宿主返回的载荷缺少可选字段时降级显示，而不是让渲染崩掉。
      const budget = s?.budget ?? { requests: 0, outputTokens: 0 }
      const models = Array.isArray(s?.models) ? s.models : []
      const plan = Array.isArray(scan.plan) ? scan.plan : []

      nodes.push(
        React.createElement(
          'div',
          { className: 'mp-warn', key: 'budget' },
          `${budget.requests} 次请求 · 约 ${budget.outputTokens} token` +
            (s?.listingOk === false ? ` · 端点列表不可用（${s.listingReason}）` : ''),
        ),
      )

      for (const m of models) {
        const findings = Array.isArray(m.findings) ? m.findings : []
        const issues = findings.filter((f) => f.verdict !== 'ok' && f.verdict !== 'unknown')
        const rows = []
        rows.push(
          React.createElement(
            'div',
            { key: 'name' },
            React.createElement('span', { className: 'mp-mname' }, m.model),
            React.createElement(
              'span',
              { className: 'mp-vals' },
              // 把"正常"与"未取证"分开报。只写 "0 项正常" 时，用户无法判断
              // 是这个模型四项都对，还是四项都没测出来。
              `  ${m.summary?.counts?.ok ?? 0} 项正常` +
                ((m.summary?.unknown ?? 0) > 0 ? ` · ${m.summary.unknown} 项未取证` : '') +
                (issues.length > 0 ? ` · ${issues.length} 项待处理` : ''),
            ),
          ),
        )
        for (const f of issues) {
          const v = VERDICT_LABEL[f.verdict] ?? { text: f.verdict, cls: 'unk' }
          const changed = f.verdict === 'out-of-range' || f.verdict === 'mismatch'
          rows.push(
            React.createElement(
              'div',
              { className: 'mp-find', key: `f-${f.field}` },
              React.createElement('span', { className: `mp-tag ${v.cls}` }, v.text),
              React.createElement('span', { className: 'mp-vals' }, FIELD_LABEL[f.field] ?? f.field),
              changed
                ? React.createElement(
                    'span',
                    { className: 'mp-vals' },
                    `当前 ${fmt(f.current)} → 实测 ${fmt(f.measured)}`,
                  )
                : React.createElement('span', { className: 'mp-vals' }, `实测 ${fmt(f.measured)}`),
            ),
          )
          if (f.note !== undefined) {
            rows.push(React.createElement('div', { className: 'mp-note', key: `n-${f.field}` }, f.note))
          }
          if (f.evidence !== undefined) {
            rows.push(
              React.createElement(
                'div',
                { className: 'mp-ev', key: `e-${f.field}` },
                `证据：${f.evidence} · 置信度 ${f.confidence}`,
              ),
            )
          }
        }
        const notes = Array.isArray(m.notes) ? m.notes : []
        for (const note of notes) {
          rows.push(React.createElement('div', { className: 'mp-note', key: `x-${note}` }, `注：${note}`))
        }
        nodes.push(React.createElement('div', { className: 'mp-model', key: m.model }, rows))
      }

      if (plan.length > 0) {
        nodes.push(
          React.createElement(
            'div',
            { className: 'mp-plan', key: 'plan' },
            React.createElement(
              'div',
              { className: 'mp-plan-title' },
              `将写入 ${plan.length} 处修正（写入前自动备份 settings.yaml）`,
            ),
            // 展示"哪个模型的哪个字段、从什么改成什么"。写入在底层是整体替换
            // models 数组，但用户需要看到的是字段级差异，否则无从复核。
            ...plan.map((op, i) =>
              React.createElement(
                'div',
                { className: 'mp-op', key: i },
                `${op.model ?? `#${op.modelIndex}`} · ${FIELD_LABEL[op.field] ?? op.field}：` +
                  `${fmt(op.from)} → ${fmt(op.value)}`,
              ),
            ),
            React.createElement(
              'button',
              {
                className: 'mp-btn danger',
                disabled: busy !== '',
                onClick: () => applyScan(p.id),
              },
              busy === `apply:${p.id}` ? '写入中…' : '确认写入',
            ),
          ),
        )
      } else {
        // 没有待写入项有两种截然不同的原因，必须分开显示：
        //   - 确实取证并比对过，结果一致；
        //   - 一个字段都没验到（例如端点不可达）。
        // 早期版本把两者都显示成绿色的"配置与实测一致"，于是整页探测失败时
        // 界面报的是成功 —— 这个插件最不该犯的错误，而它真的发生了。
        const verification = scan.verification
        const verified = verification?.verifiedFields ?? 0
        
        // 逐模型的未取证原因，让用户知道该修什么。
        const reasons = []
        for (const m of models) {
          for (const note of Array.isArray(m.notes) ? m.notes : []) {
            if (!reasons.includes(note)) reasons.push(note)
          }
        }

        nodes.push(
          verified === 0
            ? React.createElement(
                'div',
                { className: 'mp-msg bad', key: 'noverify' },
                '本次未能取证：没有任何字段得到确认。这不代表配置正确。',
                reasons.length > 0 ? React.createElement('br') : null,
                reasons.length > 0 ? `原因：${reasons.slice(0, 3).join('；')}` : null,
              )
            : React.createElement(
                'div',
                { className: 'mp-msg good', key: 'clean' },
                `已取证 ${verified} 个字段，配置与实测一致，无需改动。` +
                  (verification.unknownFields > 0
                    ? `（另有 ${verification.unknownFields} 个字段未能取证）`
                    : ''),
              ),
        )
      }

      return nodes
    }

    /**
     * 渲染错误的兜底边界。
     *
     * 设置面板的内容区没有自己的错误边界：组件一旦在渲染中抛异常，整个面板
     * 就变成空白，用户只能看到一个空框，既没有原因也没有恢复途径——这次白屏
     * 就是这么发生的。包一层边界后，同类问题会降级成一条可读的错误提示，
     * 面板其余部分（包括左侧导航）保持可用。
     */
    class RenderBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        // 打印到控制台便于诊断；不吞掉信息。
        console.error('[dsh-model-probe] 设置页渲染失败：', error, info)
      }

      render() {
        if (this.state.error !== null) {
          return React.createElement(
            'div',
            { className: 'mp-root' },
            React.createElement('div', { className: 'mp-msg bad' }, '设置页渲染出错，已阻止其影响其它设置项。'),
            React.createElement(
              'div',
              { className: 'mp-warn' },
              String(this.state.error?.message ?? this.state.error),
            ),
            React.createElement(
              'button',
              { className: 'mp-btn', onClick: () => this.setState({ error: null }) },
              '重试',
            ),
          )
        }
        return this.props.children
      }
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'model-probe', order: 60, label: () => '模型配置实测' },
          () => React.createElement(RenderBoundary, null, React.createElement(ModelProbeSettings)),
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
