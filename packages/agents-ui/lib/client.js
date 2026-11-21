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
    /** 应用中心面板的 main 槽位 key。 */
    const APPS_PANEL_ID = 'apps'

    /**
     * 侧栏图标：用 currentColor 的内联 SVG，跟随主题着色（emoji 在深浅色下都不受控）。
     * 图形是「一个节点连两个子节点」，对应「源 → 专家/线程」这层结构。
     */
    function PanelIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': true, focusable: false,
        style: { display: 'block', flex: 'none' },
      },
      h('circle', { cx: 8, cy: 3.6, r: 1.9, stroke: 'currentColor', strokeWidth: 1.2 }),
      h('circle', { cx: 3.8, cy: 12.2, r: 1.9, stroke: 'currentColor', strokeWidth: 1.2 }),
      h('circle', { cx: 12.2, cy: 12.2, r: 1.9, stroke: 'currentColor', strokeWidth: 1.2 }),
      h('path', {
        d: 'M7.1 5.3 4.7 10.4M8.9 5.3l2.4 5.1M5.7 12.2h4.6',
        stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round',
      }))
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
    /** JSON POST（线程管理等写操作）；桥还是旧版（无 /api 路由）时由 fetchWithSource 回落。 */
    function postJson(sourceId, path, body) {
      return bridgeApi(sourceId, path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
    }
    function bridgeApi(sourceId, path, init) {
      return fetchWithSource(sourceId, path, init)
        .then(response => response.ok ? response.json() : response.text().then(text => { throw new Error('桥返回 ' + response.status + ': ' + text.slice(0, 160)) }))
    }
    /** 面板认为的「当前主视图会话」缓存键（client store 拿不到时兜底）。 */
    const SESSION_KEY = 'octop.session'

    /**
     * 当前主视图会话 id：client 侧 sessions store 里被 mainView retain 的那条
     * （工作区导航用的是同一判据：`row.retainedBy.mainView > 0`）。
     * 拿不到就退回 localStorage 里上次记住的 id；再拿不到返回空串（桥会退回「最近创建的活会话」）。
     */
    function mainSessionId(ctx) {
      let found = ''
      try {
        const store = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null
        const snapshot = store && store.list && typeof store.list.getSnapshot === 'function' ? store.list.getSnapshot() : null
        const byId = snapshot && snapshot.byId
        if (byId && typeof byId === 'object') {
          for (const row of Object.values(byId)) {
            if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) { found = String(row.id || ''); break }
          }
        }
      } catch (error) { /* client store 不在：走兜底 */ }
      if (found) {
        try { window.localStorage.setItem(SESSION_KEY, found) } catch (error) { /* 隐私模式忽略 */ }
        return found
      }
      try { return String(window.localStorage.getItem(SESSION_KEY) || '') } catch (error) { return '' }
    }

    /** 给 URL 追加 session 参数（空串则原样返回）。 */
    function withSession(path, sessionId) {
      if (!sessionId) return path
      return path + (path.includes('?') ? '&' : '?') + 'session=' + encodeURIComponent(sessionId)
    }

    /**
     * DSH 设计令牌：颜色/字体/圆角全部走主题 CSS 变量（--dsw-*），
     * 深浅色、字号设置、品牌色都由宿主决定，面板不写死颜色。
     */
    const surface = {
      root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, boxSizing: 'border-box', color: 'var(--dsw-alias-label-primary)', fontFamily: 'var(--dsw-font-family)', fontSize: 14 },
      header: { display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--dsw-alias-border-l1)', flexWrap: 'wrap', flex: 'none' },
      body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 16px' },
      footer: { flex: 'none', padding: '12px 16px', borderTop: '1px solid var(--dsw-alias-border-l1)' },
      title: { margin: 0, fontSize: 16, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
    }
    const row = { display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', margin: '2px 0', border: 'none', borderRadius: 'var(--dsw-radius-sm)', background: 'transparent', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', font: 'inherit', fontSize: 14 }
    const muted = { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: '18px' }
    const smallBtn = { ...row, width: 'auto', padding: '4px 10px', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)', fontSize: 13 }
    const iconBtn = { ...row, width: 32, height: 32, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, lineHeight: 1 }
    const card = { padding: '10px 12px', borderRadius: 'var(--dsw-radius-md)', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', marginBottom: 10 }
    const bubbleUser = { ...card }
    const bubbleAssistant = { padding: '2px 2px 12px', marginBottom: 2 }

    /** 悬停/焦点态：内联样式表达不了，注入一次全局样式（跟随主题变量）。 */
    const STYLE_ID = 'dsh-agents-panel-style'
    function ensureStyles() {
      try {
        if (document.getElementById(STYLE_ID)) return
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = [
          '.dsh-agents-row:hover{background:var(--dsw-alias-bg-layer-2)}',
          '.dsh-agents-row:active{background:var(--dsw-alias-bg-layer-3)}',
          '.dsh-agents-row:focus-visible{outline:1px solid var(--dsw-alias-border-l3);outline-offset:-1px}',
          '.dsh-agents-input:focus{outline:none;border-color:var(--dsw-alias-border-l3)}',
          '.dsh-agents-send:disabled{opacity:.45;cursor:default}',
        ].join('\n')
        document.head.appendChild(style)
      } catch (error) { /* 无 DOM 环境忽略 */ }
    }

    /** 应用中心图标：四个圆角方块（应用抽屉）。 */
    function AppsIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': true, focusable: false, style: { display: 'block', flex: 'none' },
      },
      h('rect', { x: 2.2, y: 2.2, width: 5.1, height: 5.1, rx: 1.3, stroke: 'currentColor', strokeWidth: 1.2 }),
      h('rect', { x: 8.7, y: 2.2, width: 5.1, height: 5.1, rx: 1.3, stroke: 'currentColor', strokeWidth: 1.2 }),
      h('rect', { x: 2.2, y: 8.7, width: 5.1, height: 5.1, rx: 1.3, stroke: 'currentColor', strokeWidth: 1.2 }),
      h('rect', { x: 8.7, y: 8.7, width: 5.1, height: 5.1, rx: 1.3, stroke: 'currentColor', strokeWidth: 1.2 }))
    }

    /** 对话图标：一个气泡。 */
    function ChatIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': true, focusable: false, style: { display: 'block', flex: 'none' },
      },
      h('path', {
        d: 'M2.4 4.2c0-.8.6-1.4 1.4-1.4h8.4c.8 0 1.4.6 1.4 1.4v5.2c0 .8-.6 1.4-1.4 1.4H7.2L4 13.4v-2.6H3.8c-.8 0-1.4-.6-1.4-1.4V4.2Z',
        stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round',
      }))
    }

    /**
     * 应用注册表（客户端全局，零核心改动）。应用把自己登记进来，
     * 应用中心按 order 排序渲染卡片；点击卡片走 ctx.layout.selectPanel。
     * meta: { id, title, description?, icon?, order?, kind?: 'panel' | 'conversation', available? }
     * id 必须等于该应用注册到 main 槽位的 key。
     */
    const APPS_GLOBAL = '__DSH_APPS__'
    /** 应用中心是否正在显示（系统返回键用：在应用中心按返回 = 回对话）。 */
    let appsVisible = false
    function appRegistry() {
      try {
        const current = window[APPS_GLOBAL]
        if (current && Array.isArray(current.list) && typeof current.register === 'function') return current
        const list = []
        const registry = {
          list,
          register(meta) {
            if (!meta || !meta.id) return
            const index = list.findIndex(item => item.id === meta.id)
            if (index >= 0) list[index] = { ...list[index], ...meta }
            else list.push(meta)
            try { window.dispatchEvent(new CustomEvent('dsh-apps-changed')) } catch (error) { /* 忽略 */ }
          },
        }
        window[APPS_GLOBAL] = registry
        return registry
      } catch (error) {
        return { list: [], register() {} }
      }
    }

    /** 订阅注册表变化（注册晚于渲染也能刷出来）。 */
    function useApps() {
      const [apps, setApps] = React.useState(() => appRegistry().list.slice())
      React.useEffect(() => {
        const sync = () => setApps(appRegistry().list.slice())
        window.addEventListener('dsh-apps-changed', sync)
        sync()
        return () => window.removeEventListener('dsh-apps-changed', sync)
      }, [])
      return apps
    }

    function AppCenter(props) {
      const ctx = props && props.ctx ? props.ctx : null
      const apps = useApps()
      React.useEffect(() => {
        appsVisible = true
        return () => { appsVisible = false }
      }, [])
      const sorted = apps.slice().sort((a, b) => (a.order || 100) - (b.order || 100))
      const open = app => {
        try {
          const layout = ctx && typeof ctx.get === 'function' ? ctx.get('layout') : null
          if (!layout || typeof layout.selectPanel !== 'function') return
          layout.selectPanel(app.kind === 'conversation' ? null : app.id)
        } catch (error) { /* 面板没注册时忽略 */ }
      }
      return h('div', { style: surface.root },
        h('div', { style: surface.header },
          h('h2', { style: { ...surface.title, fontSize: 18 } }, '应用'),
          h('span', { style: muted }, sorted.length + ' 个')),
        h('div', { style: surface.body },
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 } },
            sorted.map(app => h('button', {
              key: app.id,
              type: 'button',
              className: 'dsh-agents-row',
              disabled: app.available === false,
              onClick: () => open(app),
              style: {
                display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8,
                padding: '14px 12px', borderRadius: 'var(--dsw-radius-md)',
                border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)',
                color: 'var(--dsw-alias-label-primary)', textAlign: 'left', font: 'inherit', cursor: 'pointer',
                opacity: app.available === false ? 0.45 : 1, minHeight: 96,
              },
            },
            h('span', { style: { color: 'var(--dsw-alias-label-secondary)', display: 'inline-flex' } }, app.icon ? h(app.icon, { size: 22 }) : h(AppsIcon, { size: 22 })),
            h('span', { style: { fontWeight: 500, fontSize: 14 } }, app.title || app.id),
            app.description ? h('span', { style: muted }, app.description) : null))),
          sorted.length === 0 ? h('p', { style: muted }, '还没有注册任何应用') : null))
    }

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
      const [lastPrompt, setLastPrompt] = React.useState('')
      const [editingTitle, setEditingTitle] = React.useState(null)
      const [confirmHide, setConfirmHide] = React.useState(false)
      const [activeThreadId, setActiveThreadId] = React.useState('')
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
          // 应用中心：返回键回对话（selectPanel(null)）
          if (appsVisible) {
            try {
              const layout = ctx && typeof ctx.get === 'function' ? ctx.get('layout') : null
              if (layout && typeof layout.selectPanel === 'function') {
                layout.selectPanel(null)
                return true
              }
            } catch (error) { /* 忽略 */ }
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
          .then(list => {
            if (!alive) return
            setExperts(Array.isArray(list) ? list : [])
            // 打开专家列表往往顺手完成了 Octop 登录；再拉一次源状态，避免源切换条停在
            // 启动时那份「Octop 未登录 → 置灰」的旧快照上，切走就切不回来。
            bridge('/sources').then(next => { if (alive) setSources(Array.isArray(next) ? next : []) }).catch(() => {})
          })
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
        bridgeApi(source, withSession('/threads?agent=' + encodeURIComponent(next.id), mainSessionId(ctx)))
          .then(list => setThreads(Array.isArray(list) ? list : []))
          .catch(err => setError(String(err && err.message ? err.message : err)))
      }

      function openThread(next) {
        try { window.history.pushState({ octop: 'messages' }, '') } catch (error) { /* 忽略 */ }
        setThread(next); setHistory(null); setError(''); setEditingTitle(null); setConfirmHide(false)
        bridgeApi(source, withSession('/history?agent=' + encodeURIComponent(expert.id) + '&thread=' + encodeURIComponent(next.id), mainSessionId(ctx)))
          .then(list => setHistory(Array.isArray(list) ? list : []))
          .catch(err => setError(String(err && err.message ? err.message : err)))
      }

      function reloadHistory(threadId) {
        bridgeApi(source, withSession('/history?agent=' + encodeURIComponent(expert.id) + '&thread=' + encodeURIComponent(threadId), mainSessionId(ctx)))
          .then(list => setHistory(Array.isArray(list) ? list : []))
          .catch(err => setError(String(err && err.message ? err.message : err)))
      }

      function sendStream(prompt) {
        const target = thread.id || ''
        return fetchWithSource(source, '/chat-stream', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agent: expert.id, thread: target, prompt, source, session: mainSessionId(ctx) }),
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
              if (frame.chunk) {
                setApproval(null)
                // 同一轮的增量并进同一个气泡，别让每个 token 都占一行
                setHistory(rows => {
                  const list = rows || []
                  const last = list[list.length - 1]
                  if (last && last.__live && last.role === 'assistant') {
                    return [...list.slice(0, -1), { ...last, text: last.text + frame.chunk }]
                  }
                  return [...list, { role: 'assistant', text: frame.chunk, __live: true }]
                })
              }
              if (frame.approval) setApproval({ summary: frame.approval })
              if (frame.error) setError(frame.error)
              // 新对话：子会话一建立（threadId 帧）就把 id 接上，停止按钮才能定位到它；
              // done 帧再兜一次，兼容旧桥。
              if (frame.threadId) {
                const created = String(frame.threadId)
                setActiveThreadId(current => current || created)
                setThread(current => (current && !current.id ? { ...current, id: created, title: current.title || '新对话' } : current))
              }
              if (frame.done && frame.threadId) {
                const created = String(frame.threadId)
                setThread(current => (current && !current.id ? { ...current, id: created, title: current.title || '新对话' } : current))
              }
            }
            return pump()
          })
          return pump()
        })
      }

      function send(promptArg, isRetry) {
        const prompt = String(promptArg !== undefined ? promptArg : draft).trim()
        if (!prompt || sending) return
        setSending(true); setError(''); setLastPrompt(prompt); setActiveThreadId(thread && thread.id ? String(thread.id) : '')
        setHistory(rows => {
          const list = rows || []
          if (!isRetry) return [...list, { role: 'user', text: prompt }]
          // 重试：上一轮可能留下半截流式气泡，先把末尾的 live 气泡去掉
          const trimmed = list.filter((row, index) => !(index === list.length - 1 && row && row.__live && row.role === 'assistant'))
          return trimmed
        })
        sendStream(prompt)
          .then(() => { setDraft('') })
          .catch(err => setError(String(err && err.message ? err.message : err)))
          .finally(() => { setSending(false); refreshThreads() })
      }

      function stop() {
        const id = activeThreadId || (thread && thread.id) || ''
        if (!id) return
        postJson(source, '/cancel', { thread: id })
          .catch(err => setError(String(err && err.message ? err.message : err)))
      }

      function refreshThreads() {
        if (!expert) return
        bridgeApi(source, withSession('/threads?agent=' + encodeURIComponent(expert.id), mainSessionId(ctx)))
          .then(list => setThreads(Array.isArray(list) ? list : []))
          .catch(() => {})
      }

      function saveTitle() {
        if (!thread || !thread.id) return
        const title = String(editingTitle || '').trim()
        if (!title) { setEditingTitle(null); return }
        postJson(source, '/thread-meta', { thread: thread.id, title })
          .then(() => { setThread(current => (current ? { ...current, title } : current)); setEditingTitle(null); refreshThreads() })
          .catch(err => setError(String(err && err.message ? err.message : err)))
      }

      function hideThread() {
        if (!thread || !thread.id) return
        if (!confirmHide) { setConfirmHide(true); return }
        postJson(source, '/thread-meta', { thread: thread.id, hidden: true })
          .then(() => { setThread(null); setHistory(null); setApproval(null); setConfirmHide(false); refreshThreads() })
          .catch(err => setError(String(err && err.message ? err.message : err)))
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

      const back = action => h('button', { type: 'button', style: iconBtn, onClick: action, 'aria-label': '返回' }, '←')

      if (error) {
        return h('div', { style: surface.root },
          h('div', { style: surface.header }, h('h2', { style: surface.title }, PANEL_TITLE)),
          h('div', { style: surface.body },
            h('p', { style: { color: 'var(--dsw-alias-state-warn-label, #d9534f)', whiteSpace: 'pre-wrap', lineHeight: '22px' } }, error),
            h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              lastPrompt ? h('button', { type: 'button', style: smallBtn, onClick: () => { setError(''); send(lastPrompt, true) } }, '重试上一条') : null,
              h('button', { type: 'button', style: smallBtn, onClick: () => { setError(''); setExpert(null); setThread(null); setHistory(null); setThreads(null) } }, '返回源列表'))))
      }

      if (!expert) {
        return h('div', { style: surface.root },
          h('div', { style: surface.header },
            h('h2', { style: { ...surface.title, fontSize: 18 } }, PANEL_TITLE),
            h('span', { style: muted }, '选择来源')),
          h('div', { style: surface.body },
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
                border: item.id === source ? '1px solid var(--dsw-alias-border-l3)' : '1px solid var(--dsw-alias-border-l1)',
                background: item.id === source ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                color: item.id === source ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
                opacity: item.available === false ? 0.4 : 1,
              },
            }, item.label + (item.available === false ? '（未接入）' : '')))) : null,
            experts === null ? h('p', { style: muted }, '加载专家…') : null,
            experts !== null && experts.length === 0 ? h('p', { style: muted }, '没有可调用的专家') : null,
            (experts || []).map(item => h('button', { key: item.id, type: 'button', className: 'dsh-agents-row', style: row, onClick: () => openExpert(item) },
              h('div', { style: { fontWeight: 500 } }, item.name),
              h('div', { style: muted }, item.description || item.id)))))
      }

      if (!thread) {
        return h('div', { style: surface.root },
          h('div', { style: surface.header },
            back(() => window.history.back()),
            h('h2', { style: surface.title }, expert.name)),
          h('div', { style: surface.body },
            h('button', {
              type: 'button',
              className: 'dsh-agents-row',
              style: { ...row, background: 'var(--dsw-alias-bg-layer-2)', marginBottom: 8 },
              onClick: () => { setThread({ id: '', title: '新对话', writable: true }); setHistory([]); setEditingTitle(null); setConfirmHide(false) },
            }, '＋ 新对话'),
            threads === null ? h('p', { style: muted }, '加载线程…') : null,
            threads !== null && threads.length === 0 ? h('p', { style: muted }, '这个专家还没有线程') : null,
            (threads || []).map(item => h('button', { key: item.id, type: 'button', className: 'dsh-agents-row', style: row, onClick: () => openThread(item) },
              h('div', { style: { fontWeight: 500 } }, item.title || '(无标题)'),
              h('div', { style: muted }, String(item.updatedAt || item.id))))))
      }

      const canManage = Boolean(thread && thread.id)
      return h('div', { style: surface.root },
        h('div', { style: surface.header },
          back(() => window.history.back()),
          editingTitle === null
            ? h('h2', { style: surface.title }, thread.title || thread.id)
            : h('input', {
              value: editingTitle,
              className: 'dsh-agents-input',
              style: { flex: 1, minWidth: 120, padding: '6px 10px', borderRadius: 'var(--dsw-radius-sm)', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit' },
              onChange: event => setEditingTitle(event.target.value),
              onKeyDown: event => {
                if (event.key === 'Enter') saveTitle()
                if (event.key === 'Escape') setEditingTitle(null)
              },
            }),
          canManage && editingTitle === null ? h('button', { type: 'button', style: smallBtn, onClick: () => { setEditingTitle(thread.title || ''); setConfirmHide(false) } }, '改名') : null,
          canManage && editingTitle !== null ? h('button', { type: 'button', style: smallBtn, onClick: saveTitle }, '保存') : null,
          canManage ? h('button', { type: 'button', style: { ...smallBtn, color: confirmHide ? 'var(--dsw-alias-state-warn-label, #d9534f)' : 'inherit' }, onClick: hideThread }, confirmHide ? '确认隐藏？' : '隐藏') : null),
        h('div', { style: surface.body },
          history === null ? h('p', { style: muted }, '加载历史…') : null,
          (history || []).map((message, index) => message.role === 'user'
            ? h('div', { key: index, style: bubbleUser },
              h('div', { style: { ...muted, marginBottom: 4 } }, '你'),
              h('div', { style: { whiteSpace: 'pre-wrap', lineHeight: '22px' } }, message.text))
            : h('div', { key: index, style: bubbleAssistant },
              h('div', { style: { ...muted, marginBottom: 4 } }, message.role === 'assistant' ? '助手' : message.role),
              h('div', { style: { whiteSpace: 'pre-wrap', lineHeight: '22px' } }, message.text))),
          approval && source === 'octop' ? h('div', { style: { ...card, borderColor: 'var(--dsw-alias-state-warn-label, #d9a441)' } },
            h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '专家在等审批'),
            h('div', { style: { ...muted, whiteSpace: 'pre-wrap', marginBottom: 8 } }, approval.summary),
            h('div', { style: { display: 'flex', gap: 8 } },
              h('button', { type: 'button', style: smallBtn, onClick: () => decide('approve') }, '允许'),
              h('button', { type: 'button', style: smallBtn, onClick: () => decide('reject') }, '拒绝'))) : null),
        h('div', { style: surface.footer },
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'flex-end' } },
            h('textarea', {
              value: draft,
              placeholder: source === 'dsh' ? '给 DSH 子 agent 发消息…' : '给这位专家发消息…',
              rows: 2,
              className: 'dsh-agents-input',
              style: { flex: 1, resize: 'vertical', padding: '8px 10px', borderRadius: 'var(--dsw-radius-md)', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', lineHeight: '22px', minHeight: 52 },
              onChange: event => setDraft(event.target.value),
            }),
            sending
              ? h('button', {
                type: 'button',
                style: { ...row, width: 'auto', padding: '8px 14px', borderRadius: 'var(--dsw-radius-md)', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)' },
                onClick: stop,
              }, '停止')
              : h('button', {
                type: 'button',
                disabled: draft.trim() === '',
                className: 'dsh-agents-send',
                style: { ...row, width: 'auto', padding: '8px 14px', borderRadius: 'var(--dsw-radius-md)', background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-on-color, #fff)', fontWeight: 500 },
                onClick: () => send(),
              }, '发送'))))
    }

    function apply(ctx) {
      ensureStyles()
      const RemotePanel = () => h(OctopPanel, { ctx })
      const AppsPanel = () => h(AppCenter, { ctx })
      ctx.slots.inject(`main`, () => ctx.slots.register({ name: `main`, key: PANEL_ID }, RemotePanel))
      ctx.slots.inject(`main`, () => ctx.slots.register({ name: `main`, key: APPS_PANEL_ID }, AppsPanel))
      ctx.slots.inject(`sidebar.panellist`, () => ctx.slots.register(
        { name: `sidebar.panellist`, id: PANEL_ID, order: 10, label: () => PANEL_TITLE },
        PanelIcon,
      ))
      ctx.slots.inject(`sidebar.panellist`, () => ctx.slots.register(
        { name: `sidebar.panellist`, id: APPS_PANEL_ID, order: 5, label: () => '应用' },
        AppsIcon,
      ))
      // 应用中心里把「Octop 面板」和「对话」登记成两个应用
      appRegistry().register({
        id: PANEL_ID, title: PANEL_TITLE, order: 10,
        description: 'Octop / DSH / ACP 多源对话', icon: PanelIcon,
      })
      appRegistry().register({
        id: 'conversation', title: '对话', order: 1, kind: 'conversation',
        description: '回到当前会话', icon: ChatIcon,
      })
    }

    exports.apply = apply
    exports.inject = [`slots`]
    return module.exports
  },
})
