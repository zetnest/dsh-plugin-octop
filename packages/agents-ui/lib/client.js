/**
 * 侧边栏 Agents 面板：源 → 专家 → 线程 → 消息。
 *
 * 数据走本机 HTTP 桥（127.0.0.1:8791）。桥按源分路由 /api/<源>/…，
 * 面板只认 backend 的 5 个方法，不认具体源（octop / dsh / 以后的 acp、cli）。
 */

window.__ModuleLoader__.load({
  id: `@seven/dsh-plugin-agents-ui`,
  factory: require => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: `Module` })

    const React = require('react')
    const h = React.createElement
    const PANEL_ID = `octop`
    const PANEL_TITLE = `Octop`

    function PanelIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      return h('span', { 'aria-hidden': true, style: { fontSize: Math.min(size, 18), lineHeight: 1 } }, '🐙')
    }

    const BRIDGE = 'http://127.0.0.1:8791'
    const BRIDGE_TOKEN = 'octop-bridge-7f3a9c'
    function bridge(path) {
      return fetch(BRIDGE + path, { headers: { authorization: 'Bearer ' + BRIDGE_TOKEN } })
        .then(response => response.ok ? response.json() : response.text().then(text => { throw new Error('桥返回 ' + response.status + ': ' + text.slice(0, 160)) }))
    }
    /** 原始 Response 版的带源请求（流式/审批用）。 */
    function fetchWithSource(sourceId, path, init) {
      const request = { ...(init || {}), headers: { authorization: 'Bearer ' + BRIDGE_TOKEN, ...((init && init.headers) || {}) } }
      return fetch(BRIDGE + '/api/' + encodeURIComponent(sourceId) + path, request).then(response => {
        if (response.status !== 404) return response
        return fetch(BRIDGE + path, request)
      })
    }
    /** 带源前缀的 JSON 请求；桥还是旧版（无 /api 路由）时回落到老路径，面板不至于白屏。 */
    function bridgeApi(sourceId, path, init) {
      return fetchWithSource(sourceId, path, init)
        .then(response => response.ok ? response.json() : response.text().then(text => { throw new Error('桥返回 ' + response.status + ': ' + text.slice(0, 160)) }))
    }
    const row = { display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', margin: '2px 0', border: 'none', borderRadius: 8, background: 'transparent', color: 'inherit', cursor: 'pointer' }
    const muted = { opacity: 0.6, fontSize: 12 }
    const bubble = { padding: '10px 12px', borderRadius: 10, background: 'rgba(127,127,127,0.08)', marginBottom: 8 }

    function OctopPanel(props) {
      const ctx = props && props.ctx ? props.ctx : null
      const [experts, setExperts] = React.useState(null)
      const [expert, setExpert] = React.useState(null)
      const [threads, setThreads] = React.useState(null)
      const [thread, setThread] = React.useState(null)
      const [history, setHistory] = React.useState(null)
      const [error, setError] = React.useState('')
      const [draft, setDraft] = React.useState('')
      const [sending, setSending] = React.useState(false)
      const [approval, setApproval] = React.useState(null)
      const [sources, setSources] = React.useState([])
      const [source, setSource] = React.useState('octop')
      const expertRef = React.useRef(null)
      const threadRef = React.useRef(null)
      React.useEffect(() => { expertRef.current = expert }, [expert])
      React.useEffect(() => { threadRef.current = thread }, [thread])

      // 系统返回键：宿主通过 window.__DSHM_BACK__.consume() 询问页面是否消费
      React.useEffect(() => {
        const bridge = window.__DSHM_BACK__
        if (!bridge || typeof bridge.consume !== 'function' || bridge.__octopWrapped) return
        const original = bridge.consume.bind(bridge)
        bridge.__octopWrapped = true
        bridge.consume = (...args) => {
          // 有层级就自己退一层并声明已消费
          if (expertRef.current !== null) {
            if (threadRef.current !== null) { setThread(null); setHistory(null); setApproval(null) }
            else { setExpert(null); setThreads(null) }
            return true
          }
          return original(...args)
        }
        return () => { bridge.consume = original; bridge.__octopWrapped = false }
      }, [])

      // 浏览器/网页容器内的返回（保留）
      React.useEffect(() => {
        const onPop = () => {
          setApproval(null); setError('')
          setExpert(current => {
            if (current === null) return current
            setThread(t => {
              if (t !== null) { setThread(null); setHistory(null); return null }
              setExpert(null); setThreads(null); return null
            })
            return current
          })
        }
        window.addEventListener('popstate', onPop)
        return () => window.removeEventListener('popstate', onPop)
      }, [])

      React.useEffect(() => {
        let alive = true
        bridge('/sources').then(list => { if (alive) setSources(Array.isArray(list) ? list : []) }).catch(() => {})
        return () => { alive = false }
      }, [])

      React.useEffect(() => {
        let alive = true
        setExperts(null)
        bridgeApi(source, '/experts')
          .then(list => { if (alive) setExperts(Array.isArray(list) ? list : []) })
          .catch(err => { if (alive) setError(String(err && err.message ? err.message : err)) })
        return () => { alive = false }
      }, [ctx, source])

      function switchSource(nextId) {
        if (nextId === source) return
        setSource(nextId)
        setExpert(null); setThreads(null); setThread(null); setHistory(null)
        setApproval(null); setError(''); setDraft('')
      }

      function openExpert(next) {
        try { window.history.pushState({ octop: 'threads' }, '') } catch (error) { /* 忽略 */ }
        setExpert(next); setThreads(null); setThread(null); setHistory(null); setError('')
        bridgeApi(source, '/threads?agent=' + encodeURIComponent(next.id))
          .then(list => setThreads(Array.isArray(list) ? list : []))
          .catch(err => setError(String(err && err.message ? err.message : err)))
      }

      function openThread(next) {
        try { window.history.pushState({ octop: 'messages' }, '') } catch (error) { /* 忽略 */ }
        setThread(next); setHistory(null); setError('')
        bridgeApi(source, '/history?agent=' + encodeURIComponent(expert.id) + '&thread=' + encodeURIComponent(next.id))
          .then(list => setHistory(Array.isArray(list) ? list : []))
          .catch(err => setError(String(err && err.message ? err.message : err)))
      }

      function reloadHistory(threadId) {
        bridgeApi(source, '/history?agent=' + encodeURIComponent(expert.id) + '&thread=' + encodeURIComponent(threadId))
          .then(list => setHistory(Array.isArray(list) ? list : []))
          .catch(err => setError(String(err && err.message ? err.message : err)))
      }

      function sendStream(prompt) {
        const target = thread.id || ''
        return fetchWithSource(source, '/chat-stream', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agent: expert.id, thread: target, prompt, source }),
        }).then(response => {
          if (!response.ok) throw new Error('桥返回 ' + response.status)
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          const pump = () => reader.read().then(({ done, value }) => {
            if (done) return
            buffer += decoder.decode(value, { stream: true })
            let index
            while ((index = buffer.indexOf('\n\n')) >= 0) {
              const event = buffer.slice(0, index)
              buffer = buffer.slice(index + 2)
              const line = event.split('\n').find(row => row.startsWith('data:'))
              if (!line) continue
              let frame
              try { frame = JSON.parse(line.slice(5).trim()) } catch (error) { continue }
              if (frame.chunk) setApproval(null), setHistory(rows => [...(rows || []), { role: 'assistant', text: frame.chunk, __live: true }])
              if (frame.approval) setApproval({ summary: frame.approval })
              if (frame.error) setError(frame.error)
            }
            return pump()
          })
          return pump()
        })
      }

      function send() {
        const prompt = draft.trim()
        if (!prompt || sending) return
        setSending(true); setError('')
        setHistory(rows => [...(rows || []), { role: 'user', text: prompt }])
        sendStream(prompt)
          .then(() => { setDraft('') })
          .catch(err => setError(String(err && err.message ? err.message : err)))
          .finally(() => setSending(false))
      }

      function decide(decision) {
        if (sending) return
        setSending(true)
        fetchWithSource(source, '/approve', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agent: expert.id, thread: thread.id, decision, source }),
        }).then(response => response.ok ? response.json() : response.text().then(text => { throw new Error('桥返回 ' + response.status + ': ' + text.slice(0, 200)) }))
          .then(() => { setApproval(null); reloadHistory(thread.id) })
          .catch(err => setError(String(err && err.message ? err.message : err)))
          .finally(() => setSending(false))
      }

      const back = action => h('button', { type: 'button', style: { ...row, width: 'auto', padding: '4px 10px' }, onClick: action }, '←')

      if (error) {
        return h('div', { style: { padding: 24 } },
          h('h2', { style: { margin: '0 0 8px', fontSize: 18 } }, PANEL_TITLE),
          h('p', { style: { color: '#d9534f', whiteSpace: 'pre-wrap' } }, error),
          h('button', {
            type: 'button',
            style: { ...row, width: 'auto', padding: '6px 12px', background: 'rgba(127,127,127,0.18)' },
            onClick: () => { setError(''); setExpert(null); setThread(null); setHistory(null); setThreads(null) },
          }, '返回源列表'))
      }

      if (!expert) {
        return h('div', { style: { padding: 24, boxSizing: 'border-box' } },
          h('h2', { style: { margin: '0 0 12px', fontSize: 18, fontWeight: 600 } }, PANEL_TITLE),
          sources.length > 1 ? h('div', { style: { display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' } },
            sources.map(item => h('button', {
              key: item.id,
              type: 'button',
              disabled: item.available === false,
              onClick: () => switchSource(item.id),
              title: item.detail || '',
              style: {
                ...muted,
                padding: '4px 10px',
                borderRadius: 999,
                cursor: item.available === false ? 'default' : 'pointer',
                border: item.id === source ? '1px solid rgba(127,127,127,0.75)' : '1px solid rgba(127,127,127,0.3)',
                background: item.id === source ? 'rgba(127,127,127,0.14)' : 'transparent',
                color: 'inherit',
                opacity: item.available === false ? 0.4 : (item.id === source ? 1 : 0.7),
              },
            }, item.label + (item.available === false ? '（未接入）' : '')))) : null,
          experts === null ? h('p', { style: muted }, '加载专家…') : null,
          experts !== null && experts.length === 0 ? h('p', { style: muted }, '没有可调用的专家') : null,
          (experts || []).map(item => h('button', { key: item.id, type: 'button', style: row, onClick: () => openExpert(item) },
            h('div', { style: { fontWeight: 500 } }, item.name),
            h('div', { style: muted }, item.description || item.id))))
      }

      if (!thread) {
        return h('div', { style: { padding: 24, boxSizing: 'border-box' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 } },
            back(() => window.history.back()),
            h('h2', { style: { margin: 0, fontSize: 16, fontWeight: 600 } }, expert.name)),
          threads === null ? h('p', { style: muted }, '加载线程…') : null,
          threads !== null && threads.length === 0 ? h('p', { style: muted }, '这个专家还没有线程') : null,
          h('button', { type: 'button', style: { ...row, background: 'rgba(127,127,127,0.14)' }, onClick: () => { setThread({ id: '', title: '新对话', writable: true }); setHistory([]) } }, '＋ 新对话'),
          (threads || []).map(item => h('button', { key: item.id, type: 'button', style: row, onClick: () => openThread(item) },
            h('div', { style: { fontWeight: 500 } }, item.title || '(无标题)'),
            h('div', { style: muted }, '' + (item.updatedAt || item.id)))))
      }

      return h('div', { style: { padding: 24, boxSizing: 'border-box' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 } },
          back(() => window.history.back()),
          h('h2', { style: { margin: 0, fontSize: 16, fontWeight: 600 } }, thread.title || thread.id)),
        history === null ? h('p', { style: muted }, '加载历史…') : null,
        (history || []).map((message, index) => h('div', { key: index, style: bubble },
          h('div', { style: { ...muted, marginBottom: 4 } }, message.role),
          h('div', { style: { whiteSpace: 'pre-wrap' } }, message.text))),
        approval && source === 'octop' ? h('div', { style: { ...bubble, border: '1px solid #d9a441' } },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '专家在等审批'),
          h('div', { style: { ...muted, whiteSpace: 'pre-wrap', marginBottom: 8 } }, approval.summary),
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', { type: 'button', style: { ...row, width: 'auto', padding: '6px 12px', background: 'rgba(127,127,127,0.18)' }, onClick: () => decide('approve') }, '允许'),
            h('button', { type: 'button', style: { ...row, width: 'auto', padding: '6px 12px', background: 'rgba(127,127,127,0.18)' }, onClick: () => decide('reject') }, '拒绝'))) : null,
        h('div', { style: { display: 'flex', gap: 8, marginTop: 12 } },
          h('textarea', {
            value: draft,
            placeholder: source === 'dsh' ? '给这个 DSH 子 agent 发消息…' : '给这个专家发消息…',
            rows: 2,
            style: { flex: 1, resize: 'vertical', padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(127,127,127,0.35)', background: 'transparent', color: 'inherit', font: 'inherit' },
            onChange: event => setDraft(event.target.value),
          }),
          h('button', {
            type: 'button',
            disabled: sending || draft.trim() === '',
            style: { ...row, width: 'auto', padding: '8px 14px', background: 'rgba(127,127,127,0.18)', opacity: sending || draft.trim() === '' ? 0.5 : 1 },
            onClick: send,
          }, sending ? '发送中…' : '发送')))
    }

    function apply(ctx) {
      const RemotePanel = () => h(OctopPanel, { ctx })
      ctx.slots.inject(`main`, () => ctx.slots.register({ name: `main`, key: PANEL_ID }, RemotePanel))
      ctx.slots.inject(`sidebar.panellist`, () => ctx.slots.register(
        { name: `sidebar.panellist`, id: PANEL_ID, order: 10, label: () => PANEL_TITLE },
        PanelIcon,
      ))
    }

    exports.apply = apply
    exports.inject = [`slots`]
    return module.exports
  },
})
