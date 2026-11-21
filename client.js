/**
 * Browser half of dsh-zhipu-multimodal: a Breeze voice page.
 *
 * One navigation row (`sidebar.panellist`) and one central page (`main`), the
 * same pair the shipped Plugins/Images pages use. The page talks only to the
 * bundle's same-origin Host routes; Breeze itself is never exposed to CORS.
 *
 * Hand-authored in the client module-loader format. React is a baseline module.
 */
window.__ModuleLoader__.load({
  id: 'dsh-zhipu-multimodal',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'breeze'
    const STYLE_ID = 'dsh-zhipu-breeze-style'
    const DEFAULT_INSTRUCTION = 'Speak clearly and naturally.'

    const CSS = `
.dshb-page {
  height: 100%; overflow: auto; box-sizing: border-box;
  padding: calc(var(--dsh-frame-top-clearance, 48px) + 22px) 40px 48px;
  color: var(--dsw-alias-label-primary, #0f1115);
  background: var(--dsw-alias-bg-base, transparent);
  font-family: var(--dsw-font-family, -apple-system, "PingFang SC", system-ui, sans-serif);
}
.dshb-inner { max-width: 820px; margin: 0 auto; }
.dshb-head { display: flex; align-items: center; justify-content: space-between; gap: 18px; }
.dshb-title { margin: 0; font-size: 24px; font-weight: 650; letter-spacing: .01em; }
.dshb-sub { margin: 6px 0 0; color: var(--dsw-alias-label-secondary, #6b7280); font-size: 13px; }
.dshb-status { display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280); }
.dshb-dot { width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; }
.dshb-dot.on { background: #1a9b63; box-shadow: 0 0 0 3px rgba(26,155,99,.14); }
.dshb-card {
  margin-top: 22px; padding: 22px; border-radius: 16px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22));
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.045));
}
.dshb-label { display: block; margin: 0 0 8px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, #6b7280); }
.dshb-textarea, .dshb-input {
  width: 100%; box-sizing: border-box; border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28));
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-primary, #0f1115);
  font: inherit; outline: none;
}
.dshb-textarea { min-height: 132px; resize: vertical; padding: 13px 14px; line-height: 1.55; }
.dshb-input { height: 38px; padding: 0 11px; }
.dshb-textarea:focus, .dshb-input:focus { border-color: var(--dsw-alias-brand-primary, #4c6ef5); }
.dshb-row { display: grid; grid-template-columns: 1.7fr 1fr .55fr; gap: 12px; margin-top: 14px; }
.dshb-actions { display: flex; align-items: center; gap: 10px; margin-top: 16px; flex-wrap: wrap; }
.dshb-button {
  appearance: none; border: 0; border-radius: 9px; padding: 9px 16px;
  background: var(--dsw-alias-brand-primary, #4c6ef5); color: #fff;
  font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
}
.dshb-button:disabled { opacity: .55; cursor: default; }
.dshb-button.secondary {
  background: transparent; color: var(--dsw-alias-label-primary, #0f1115);
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3));
}
.dshb-hint { color: var(--dsw-alias-label-tertiary, #8b93a1); font-size: 12px; }
.dshb-error { margin-top: 14px; padding: 11px 13px; border-radius: 9px; background: rgba(220,53,69,.09); color: #b42334; font-size: 13px; line-height: 1.5; white-space: pre-wrap; }
.dshb-audio { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18)); }
.dshb-audio audio { width: 100%; }
.dshb-foot { margin-top: 18px; color: var(--dsw-alias-label-tertiary, #8b93a1); font-size: 12px; line-height: 1.6; }
@media (max-width: 760px) {
  .dshb-page { padding-left: 18px; padding-right: 18px; }
  .dshb-row { grid-template-columns: 1fr; }
}
`

    function PanelIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('rect', { x: 5.2, y: 1.8, width: 5.6, height: 8.2, rx: 2.8 }),
      h('path', { d: 'M3.1 7.4a4.9 4.9 0 0 0 9.8 0M8 12.3v2.1M5.6 14.4h4.8' }))
    }

    function StatusPill({ status }) {
      const running = Boolean(status?.running)
      return h('div', { className: 'dshb-status' },
        h('span', { className: running ? 'dshb-dot on' : 'dshb-dot' }),
        running ? 'Breeze 在线' : 'Breeze 离线')
    }

    function VoicePage() {
      const [text, setText] = React.useState('')
      const [instruction, setInstruction] = React.useState(DEFAULT_INSTRUCTION)
      const [voice, setVoice] = React.useState('')
      const [seed, setSeed] = React.useState('42')
      const [status, setStatus] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [starting, setStarting] = React.useState(false)
      const [error, setError] = React.useState('')
      const [audioUrl, setAudioUrl] = React.useState('')
      const audioUrlRef = React.useRef('')

      async function refreshStatus() {
        try {
          const response = await fetch('/zhipu/breeze/status', { headers: { accept: 'application/json' } })
          const body = await response.json().catch(() => ({}))
          setStatus(body.ok ? body : { running: false, error: body.error || `HTTP ${response.status}` })
        } catch (cause) {
          setStatus({ running: false, error: cause instanceof Error ? cause.message : String(cause) })
        }
      }

      React.useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const response = await fetch('/zhipu/breeze/status', { headers: { accept: 'application/json' } })
            const body = await response.json().catch(() => ({}))
            if (alive) setStatus(body.ok ? body : { running: false, error: body.error || `HTTP ${response.status}` })
          } catch (cause) {
            if (alive) setStatus({ running: false, error: cause instanceof Error ? cause.message : String(cause) })
          }
        })()
        return () => {
          alive = false
          if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
        }
      }, [])

      async function startServer() {
        setStarting(true)
        setError('')
        try {
          const response = await fetch('/zhipu/breeze/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          const body = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
          await refreshStatus()
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setStarting(false)
        }
      }

      async function generate() {
        if (busy || text.trim() === '') return
        setBusy(true)
        setError('')
        try {
          const payload = { text: text.trim(), instruction: instruction.trim() || DEFAULT_INSTRUCTION, seed: Number(seed) || 42 }
          if (voice.trim() !== '') payload.voice = voice.trim()
          const response = await fetch('/zhipu/breeze/speech', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'audio/wav' },
            body: JSON.stringify(payload),
          })
          if (!response.ok) {
            const body = await response.json().catch(() => ({}))
            throw new Error(body.error || `HTTP ${response.status}`)
          }
          const blob = await response.blob()
          const next = URL.createObjectURL(blob)
          if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
          audioUrlRef.current = next
          setAudioUrl(next)
          await refreshStatus()
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }

      const offline = status !== null && !status.running

      return h('div', { className: 'dshb-page' },
        h('div', { className: 'dshb-inner' },
          h('div', { className: 'dshb-head' },
            h('div', null,
              h('h1', { className: 'dshb-title' }, '语音'),
              h('p', { className: 'dshb-sub' }, '用本机 Breeze-TTS-2 把一句话变成语音')),
            h(StatusPill, { status })),
          h('div', { className: 'dshb-card' },
            h('label', { className: 'dshb-label', htmlFor: 'dshb-text' }, '要朗读的文字'),
            h('textarea', {
              id: 'dshb-text', className: 'dshb-textarea',
              value: text, maxLength: 4000,
              placeholder: '例如：欢迎回来。今天也辛苦了。',
              onChange: (event) => setText(event.target.value),
            }),
            h('div', { className: 'dshb-row' },
              h('div', null,
                h('label', { className: 'dshb-label', htmlFor: 'dshb-instruction' }, '音色 / 语气'),
                h('input', {
                  id: 'dshb-instruction', className: 'dshb-input',
                  value: instruction,
                  onChange: (event) => setInstruction(event.target.value),
                })),
              h('div', null,
                h('label', { className: 'dshb-label', htmlFor: 'dshb-voice' }, '音色 ID（可选）'),
                h('input', {
                  id: 'dshb-voice', className: 'dshb-input',
                  value: voice, placeholder: '留空则设计音色',
                  onChange: (event) => setVoice(event.target.value),
                })),
              h('div', null,
                h('label', { className: 'dshb-label', htmlFor: 'dshb-seed' }, 'Seed'),
                h('input', {
                  id: 'dshb-seed', className: 'dshb-input', type: 'number',
                  value: seed, min: 0,
                  onChange: (event) => setSeed(event.target.value),
                }))),
            h('div', { className: 'dshb-actions' },
              h('button', {
                type: 'button', className: 'dshb-button',
                disabled: busy || text.trim() === '',
                onClick: generate,
              }, busy ? '生成中…' : '生成语音'),
              offline
                ? h('button', {
                  type: 'button', className: 'dshb-button secondary',
                  disabled: starting,
                  onClick: startServer,
                }, starting ? '正在启动…' : '启动本地服务')
                : null,
              h('span', { className: 'dshb-hint' }, '⌘/Ctrl + Enter 生成')),
            error !== '' ? h('div', { className: 'dshb-error', role: 'alert' }, error) : null,
            audioUrl !== ''
              ? h('div', { className: 'dshb-audio' },
                h('audio', { controls: true, src: audioUrl, autoPlay: true }),
                h('p', { className: 'dshb-foot' }, '音频只保存在本机；左侧对话里的工具调用也会保存 WAV 并给出播放链接。'))
              : null),
          h('p', { className: 'dshb-foot' },
            '本地模型 · 文本不会上传。首次生成或刚启动时，模型加载可能需要几十秒；如果一直离线，先运行 Breeze-TTS-2.cpp\\start-breeze-server.cmd。')),
      )
    }

    function ensureStyle() {
      let style = document.getElementById(STYLE_ID)
      if (style === null) {
        style = document.createElement('style')
        style.id = STYLE_ID
        document.head.append(style)
      }
      if (style.textContent !== CSS) style.textContent = CSS
      return () => {
        if (style && style.parentNode) style.parentNode.removeChild(style)
      }
    }

    function apply(ctx) {
      if (typeof ctx.effect === 'function') ctx.effect(ensureStyle, 'dsh-zhipu-multimodal: Breeze styles')
      else ensureStyle()

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 60,
        label: '语音',
      }, PanelIcon))

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
      }, VoicePage))
    }

    exports.name = 'dsh-zhipu-multimodal'
    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
