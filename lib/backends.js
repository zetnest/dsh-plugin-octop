/**
 * 多源 backend 注册表。每个源实现统一 5 方法（status/listAgents/listThreads/
 * history/send），桥和面板只认接口，不认具体源。
 *
 * octop：远端 Octop 专家（REST + Agent MCP 网关），对话由 bridge 直接实现。
 * dsh  ：本进程 subagent（ctx.subagents，provider 优先 spawn）。
 *        面板每开一条对话 = 一条 continuable 子会话，threadId 就是那条子会话的
 *        Session id；后续消息用 ctx.subagents.sendMessage 热续（目标仍在内存里
 *        由 manager 保活），子会话被回收时 manager 会自动冷恢复。
 *        父 Agent 取「面板指定 / 最近创建的活会话」。
 *
 * 零依赖：只碰服务对象上的公开方法，不 import DSH 核心包（端侧模块解析到不了
 * 核心 node_modules）。
 */

/** dsh 源对外暴露的唯一角色。 */
export const DSH_AGENT = {
  id: 'dsh',
  name: 'DSH 助手',
  description: '本进程 subagent，挂在当前打开的会话下，自带工具',
}

/** 子会话写进父会话 catalog 的创建标签；listThreads 只挑带这个标签的线程。 */
export const DSH_THREAD_LABEL = 'DSH 助手'

/** 可用的 continuable provider，按优先级取第一个已注册的。 */
const DSH_PROVIDERS = ['spawn', 'fork']

/** 续聊时轮询子会话日志的间隔（毫秒）。 */
const DSH_POLL_MS = 400

/** 子 agent 一轮的默认超时。 */
const DSH_TIMEOUT_MS = 900_000

/** Octop 线程行投影（面板统一形状，epoch 秒 -> ISO）。 */
export function projectThread(row) {
  const id = row && (row.thread_id !== undefined ? row.thread_id : row.id)
  const lastActive = row && row.last_active
  return {
    id: String(id === undefined || id === null ? '' : id),
    title: String((row && (row.title || row.name)) || ''),
    updatedAt: typeof lastActive === 'number' && lastActive > 0 ? new Date(lastActive * 1000).toISOString() : '',
    // Octop 的 Agent MCP 网关只能续 MCP 自己创建的线程，其余只读
    writable: String((row && row.channel_type) || '') === 'mcp',
  }
}

/** Octop 历史消息投影 → [{role,text}]。 */
export function projectHistory(data) {
  const raw = data && Array.isArray(data.messages) ? data.messages : []
  return raw.map(message => {
    const content = message && message.content
    const text = Array.isArray(content)
      ? content.filter(b => b && b.type === 'text').map(b => b.text).join('\n')
      : (typeof content === 'string' ? content : '')
    return { role: String((message && message.role) || 'unknown'), text }
  })
}

/** 取服务；缺失或调用炸掉都返回 undefined，交给上层给出「没加载」的清楚报错。 */
function getService(ctx, name) {
  try {
    return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch (error) {
    return undefined
  }
}

/** 从 ContentBlock[] 里拼纯文本（忽略 thinking / tool 块）。 */
function contentText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text) parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** turn/end 的 reason（或 SubagentResult.stopReason）→ 面板状态词。 */
function stopReasonOf(reason) {
  const kind = reason && typeof reason === 'object' ? reason.kind : reason
  switch (kind) {
    case 'max-tokens': return 'max-tokens'
    case 'aborted':
    case 'interrupted': return 'aborted'
    case 'error': return 'error'
    case 'blocked': return 'refusal'
    default: return 'completed'
  }
}

function messageOf(error) {
  return error && error.message ? String(error.message) : String(error)
}

/** 面板传上来的会话 id → 精确存活的父 Agent（startActivation 要求对象身份一致）。 */
function resolveParent(ctx, sessionId) {
  const agents = getService(ctx, 'agents')
  if (!agents || typeof agents.get !== 'function') {
    throw new Error('agents 服务不可用：本进程没有加载 @deepseek-ai/dsh-agent')
  }
  const wanted = String(sessionId || '').trim()
  if (wanted) {
    const live = agents.get(wanted)
    if (live) return live
    // 面板可能还带着重启前缓存的会话 id；这里不硬失败，回落到最近创建的活会话。
    // 业务上的「这条线程属于哪棵树」由 send 里的 threadParents 兜底。
  }
  const list = typeof agents.list === 'function' ? agents.list() : []
  const live = Array.isArray(list) ? list : []
  // 只挑顶层会话：子会话（origin=subagent）不适合当父。
  const roots = live.filter(agent => agent && agent.session && agent.session.header
    && agent.session.header.origin !== 'subagent')
  const pool = roots.length > 0 ? roots : live
  if (pool.length === 0) throw new Error('没有活动会话：先在对话页打开一个会话，再回到面板')
  return pool.slice().sort((a, b) => {
    const left = (a.session && a.session.header && a.session.header.createdAt) || 0
    const right = (b.session && b.session.header && b.session.header.createdAt) || 0
    return right - left
  })[0]
}

/** 找已注册的 continuable provider。 */
function pickProvider(subagents, fail) {
  if (subagents && typeof subagents.getProvider === 'function') {
    for (const name of DSH_PROVIDERS) {
      try { if (subagents.getProvider(name)) return name } catch (error) { /* 继续找下一个 */ }
    }
  }
  if (!fail) return ''
  throw new Error('没有可用的 subagent provider（spawn / fork 都没注册）')
}

function requireSubagents(ctx) {
  const subagents = getService(ctx, 'subagents')
  if (!subagents || typeof subagents.startActivation !== 'function') {
    throw new Error('subagents 服务不可用：本进程没有加载 @deepseek-ai/dsh-subagent')
  }
  return subagents
}

function queryOf(ctx) {
  const query = getService(ctx, 'sessionQuery')
  if (!query || typeof query.observeSession !== 'function') {
    throw new Error('sessionQuery 服务不可用：读子会话日志需要 @deepseek-ai/dsh-session-query')
  }
  return query
}

/** 读一次会话观察租约；调用方负责 releaseObservation。 */
function observeSession(ctx, sessionId) {
  return queryOf(ctx).observeSession(String(sessionId), { projectionMode: 'none' })
}

/** 还掉观察租约（Disposable）。 */
function releaseObservation(observation) {
  try {
    const dispose = observation && typeof Symbol === 'function' ? observation[Symbol.dispose] : undefined
    if (typeof dispose === 'function') dispose.call(observation)
  } catch (error) { /* 租约释放失败不影响结果 */ }
}

function sleep(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * 一条 user/assistant 消息投影出面板消息行；工具调用不进聊天视图。
 *
 * 子会话日志里的 `user/message` 有三种来源（source.kind）：
 *   user          —— 面板/宿主发的真人 prompt（要显示）
 *   agent-message —— 本面板续聊经 sendMessage 转发的（要显示，去掉 "Agent X sent a message:" 前缀）
 *   runtime-context / skill-* / time-* … —— 每轮自动注入的系统上下文（**不显示**，否则面板里全是
 *                   <system-reminder> 大段文本）
 */
function projectEvent(event) {
  if (!event || typeof event.type !== 'string' || !event.data) return null
  if (event.type === 'user/message') {
    const source = event.data.source
    const kind = source && typeof source === 'object' ? String(source.kind || '') : ''
    let text = contentText(event.data.content)
    if (kind === 'agent-message') {
      text = text.replace(/^Agent [^\n]{0,80}? sent a message: ?/, '').trim()
      return text ? { role: 'user', text } : null
    }
    if (kind && kind !== 'user') return null
    return text ? { role: 'user', text } : null
  }
  if (event.type === 'assistant/message') {
    const text = contentText(event.data.message && event.data.message.content)
    return text ? { role: 'assistant', text } : null
  }
  return null
}

/**
 * 订阅本进程的 assistant 流，把子 agent 的 text-delta 增量转给面板。
 * 新线程在 startActivation 返回前不知道 childId，所以先按 agent id 缓存，
 * setTarget 后再冲刷——避免漏掉开头几段。
 * @param {any} ctx host 侧 cordis 上下文
 * @param {(text: string) => void} [onChunk]
 */
function createStreamTap(ctx, onChunk) {
  if (typeof onChunk !== 'function' || !ctx || typeof ctx.on !== 'function') {
    return { setTarget() {}, hasText() { return false }, text() { return '' }, close() {} }
  }
  const buffers = new Map()
  let target = ''
  let sawText = false
  let fullText = ''
  const handler = payload => {
    const agentId = payload && payload.agent ? String(payload.agent.id) : ''
    const frame = payload && payload.frame
    if (!agentId || !frame || frame.type !== 'chunk') return
    const chunk = frame.chunk
    if (!chunk || chunk.type !== 'text-delta' || typeof chunk.text !== 'string' || !chunk.text) return
    if (target === '') {
      const pending = buffers.get(agentId) || []
      pending.push(chunk.text)
      buffers.set(agentId, pending)
      return
    }
    if (agentId !== target) return
    sawText = true
    fullText += chunk.text
    try { onChunk(chunk.text) } catch (error) { /* 面板断开不影响 agent */ }
  }
  const dispose = ctx.on('agent/assistant-stream', handler)
  return {
    setTarget(id) {
      target = String(id || '')
      const pending = buffers.get(target)
      buffers.clear()
      if (!pending || pending.length === 0) return
      sawText = true
      for (const text of pending) {
        fullText += text
        try { onChunk(text) } catch (error) { /* 忽略 */ }
      }
    },
    hasText() { return sawText },
    text() { return fullText },
    close() {
      try { if (typeof dispose === 'function') dispose() } catch (error) { /* 忽略 */ }
    },
  }
}

/**
 * 建 backend 注册表。
 * @param {{client: any, mcp: any, ctx?: any}} deps
 *   ctx —— host 侧 cordis 上下文，dsh 源靠它拿 agents/subagents/sessionQuery；
 *   octop 源不需要 ctx，所以旧调用方（不传 ctx）仍能跑。
 */
export function createBackends({ client, mcp, ctx } = {}) {
  /** 面板起的线程 → 创建它的父会话 id（续聊时保证 sender 在同一条 subagent tree）。 */
  const threadParents = new Map()
  /** 面板起的子会话 id：用于拦掉它们结算时投给父会话的「Background subagent …」通知。 */
  const panelChildren = new Set()

  // 核心对「冷恢复」的子会话不保留 caller 语义（restoreTarget 不传 delivery，默认 parent），
  // 于是每轮续聊结束都会往父会话 inbox 投一条结算通知、还会唤醒父模型。面板线程只是
  // 侧栏聊天，不该打扰主会话：来源是 subagent-settled 且发送者是我们起的子会话时，直接摘掉。
  if (ctx && typeof ctx.on === 'function') {
    try {
      ctx.on('agent/inbox/inserted', payload => {
        const message = payload && payload.message
        const source = message && message.source
        if (!message || !source || typeof source !== 'object') return
        if (source.kind !== 'subagent-settled') return
        if (!panelChildren.has(String(source.senderSessionId || ''))) return
        try { payload.agent.inbox.remove(message.id) } catch (error) { /* 已被取走就算了 */ }
      })
    } catch (error) { /* 事件名变了也不影响主流程 */ }
  }

  const octop = {
    id: 'octop',
    label: 'Octop',
    async status() {
      // 令牌是懒登录的：重启后第一次 /sources 如果只看 client.token，会把 Octop 误报成不可用，
      // 面板里那个源就是灰的。这里顺手登一次（client 内部有缓存）。
      let available = Boolean(client.token)
      let detail = client.baseUrl
      if (!available && typeof client.ensureToken === 'function') {
        try {
          await client.ensureToken(false)
          available = Boolean(client.token)
        } catch (error) {
          detail = client.baseUrl + '（登录失败：' + messageOf(error) + '）'
        }
      }
      return { id: 'octop', label: 'Octop', available, detail }
    },
    async listAgents() { return (await mcp.listExperts()).map(e => ({ id: e.id, name: e.name, description: e.description })) },
    async listThreads(agentId) { return (await client.listThreads(String(agentId), 30)).map(projectThread) },
    async history(agentId, threadId) { return projectHistory(await client.history(String(agentId), String(threadId), 50)) },
    async send() { throw new Error('octop.send 由 bridge 直接实现') },
  }

  /** 有目录/标题就到手的线程行。 */
  const dsh = {
    id: 'dsh',
    label: 'DSH',
    async status() {
      const subagents = getService(ctx, 'subagents')
      const provider = subagents ? pickProvider(subagents, false) : ''
      const agents = getService(ctx, 'agents')
      let roots = []
      try { roots = agents && typeof agents.list === 'function' ? (agents.list() || []) : [] } catch (error) { roots = [] }
      const live = roots.filter(agent => agent && agent.session && agent.session.header
        && agent.session.header.origin !== 'subagent').length
      return {
        id: 'dsh',
        label: 'DSH',
        available: Boolean(provider),
        detail: provider
          ? ('本进程 subagent · provider=' + provider + ' · 活动会话 ' + live)
          : '本进程 subagent 不可用（spawn/fork 未注册）',
      }
    },

    async listAgents() { return [{ ...DSH_AGENT }] },

    /** 各活动会话下由面板起的 continuable 子会话。 */
    async listThreads(agentId, options) {
      const subagents = getService(ctx, 'subagents')
      if (!subagents || typeof subagents.listDescendants !== 'function') return []
      const agents = getService(ctx, 'agents')
      const wanted = String((options && options.session) || '').trim()
      let parents = []
      if (wanted) {
        const live = agents && typeof agents.get === 'function' ? agents.get(wanted) : undefined
        if (live) parents = [live]
      }
      if (parents.length === 0 && agents && typeof agents.list === 'function') {
        parents = (agents.list() || []).filter(agent => agent && agent.session && agent.session.header
          && agent.session.header.origin !== 'subagent')
      }
      const rows = []
      for (const parent of parents) {
        let children
        try { children = await subagents.listDescendants(parent.id) } catch (error) { continue }
        for (const row of Array.isArray(children) ? children : []) {
          if (!row || row.parentId !== parent.id) continue
          if (row.mode !== 'continuable' || row.label !== DSH_THREAD_LABEL) continue
          const id = String(row.id || '')
          if (!id) continue
          threadParents.set(id, parent.id)
          rows.push({
            id,
            title: '',
            updatedAt: typeof row.createdAt === 'number' && row.createdAt > 0 ? new Date(row.createdAt).toISOString() : '',
            writable: true,
            createdAt: typeof row.createdAt === 'number' ? row.createdAt : 0,
          })
        }
      }
      rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      // 一次批量折标题，避免每条线程各读一次日志
      const query = getService(ctx, 'sessionQuery')
      if (query && typeof query.readTitleSnapshots === 'function' && rows.length > 0) {
        try {
          const results = await query.readTitleSnapshots(rows.map(row => row.id))
          const titleOf = new Map()
          for (const result of Array.isArray(results) ? results : []) {
            if (!result || result.status !== 'fulfilled' || !result.value) continue
            titleOf.set(String(result.sessionId), result.value.title)
          }
          for (const row of rows) {
            const title = titleOf.get(row.id)
            if (!title) continue
            if (typeof title.title === 'string' && title.title) row.title = title.title
            if (typeof title.updatedAt === 'number' && title.updatedAt > 0) {
              row.updatedAt = new Date(title.updatedAt).toISOString()
            }
          }
        } catch (error) { /* 标题读不到就用兜底文案 */ }
      }
      for (const row of rows) {
        if (!row.title) row.title = DSH_AGENT.name
        delete row.createdAt
      }
      rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      return rows
    },

    /** 子会话日志 → [{role,text}]。只读 subagent 会话，防止面板读主会话。 */
    async history(agentId, threadId) {
      const id = String(threadId || '').trim()
      if (!id) return []
      const observation = await observeSession(ctx, id)
      try {
        const header = observation && observation.header
        if (!header || header.origin !== 'subagent') return []
        const events = Array.isArray(observation.events) ? observation.events : []
        const rows = []
        for (const event of events) {
          const row = projectEvent(event)
          if (row) rows.push(row)
        }
        return rows
      } finally {
        releaseObservation(observation)
      }
    },

    /**
     * 跑一轮子 agent（新线程 / 续聊）。
     * @param {string} agentId - 固定 'dsh'（保留接口形状）
     * @param {string} threadId - 空串 = 新线程；否则是子会话 id
     * @param {string} prompt
     * @param {{session?: string, timeoutMs?: number, onChunk?: (text: string) => void}} [options]
     *   session —— 父会话（面板当前打开的那条）id，新线程挂在它下面
     */
    async send(agentId, threadId, prompt, options) {
      const text = String(prompt || '')
      if (!text.trim()) throw new Error('prompt 不能为空')
      const opts = options && typeof options === 'object' ? options : {}
      const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DSH_TIMEOUT_MS
      const subagents = requireSubagents(ctx)
      const target = String(threadId || '').trim()
      const tap = createStreamTap(ctx, opts.onChunk)
      const controller = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; try { controller.abort() } catch (error) { /* 忽略 */ } }, timeoutMs)
      if (timer.unref) timer.unref()
      try {
        if (!target) {
          const parent = resolveParent(ctx, opts.session)
          return await startThread(ctx, subagents, parent, text, controller.signal, timeoutMs, tap, threadParents, panelChildren)
        }
        // 续聊：父会话必须还是同一条 subagent tree 的根
        panelChildren.add(target)
        const parent = resolveParent(ctx, threadParents.get(target) || opts.session)
        tap.setTarget(target)
        return await continueThread(ctx, subagents, parent, target, text, controller.signal, timeoutMs, tap, () => timedOut)
      } finally {
        clearTimeout(timer)
        tap.close()
      }
    },
  }


  /** ACP 源：驱动外部 ACP agent（Claude Code / Gemini CLI …）。模块按需加载。 */
  const acpThreads = new Map()
  const acpConnections = new Map()
  const acp = {
    id: 'acp',
    label: 'ACP',
    async status() {
      let mod
      try { mod = await import('./acp.js') } catch (error) {
        return { id: 'acp', label: 'ACP', available: false, detail: 'ACP 模块加载失败：' + messageOf(error) }
      }
      let agents = []
      try { agents = mod.detectAgents() } catch (error) {
        return { id: 'acp', label: 'ACP', available: false, detail: '探测 ACP agent 失败：' + messageOf(error) }
      }
      if (agents.length === 0) {
        return {
          id: 'acp', label: 'ACP', available: false,
          detail: '未检测到 ACP agent（试过 ' + mod.KNOWN_AGENTS.map(a => a.command).join(' / ') + '）；'
            + '端侧装 CLI 后还要过进程创建那关（HANDOFF E15）',
        }
      }
      return { id: 'acp', label: 'ACP', available: true, detail: agents.map(a => a.label + ' @ ' + a.path).join(' · ') }
    },

    async listAgents() {
      const mod = await import('./acp.js')
      return mod.detectAgents().map(agent => ({
        id: agent.id,
        name: agent.label + '（ACP）',
        description: agent.path + (agent.args.length ? ' ' + agent.args.join(' ') : ''),
      }))
    },

    async listThreads(agentId) {
      const wanted = String(agentId || '')
      const rows = []
      for (const thread of acpThreads.values()) {
        if (wanted && thread.agentId !== wanted) continue
        rows.push({ id: thread.id, title: thread.title, updatedAt: thread.updatedAt, writable: true })
      }
      rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      return rows
    },

    async history(agentId, threadId) {
      const thread = acpThreads.get(String(threadId || ''))
      if (!thread) return []
      return thread.messages.map(message => ({ role: message.role, text: message.text }))
    },

    async send(agentId, threadId, prompt, options) {
      const text = String(prompt || '')
      if (!text.trim()) throw new Error('prompt 不能为空')
      const opts = options && typeof options === 'object' ? options : {}
      const mod = await import('./acp.js')
      const agents = mod.detectAgents()
      if (agents.length === 0) {
        throw new Error('没有可用的 ACP agent：' + mod.KNOWN_AGENTS.map(a => a.command).join(' / ') + ' 都没找到')
      }
      const agent = agents.find(item => item.id === String(agentId)) || agents[0]
      let slot = acpConnections.get(agent.id)
      if (!slot) {
        const cwd = acpCwd(ctx, opts.session)
        slot = { connection: null, sessions: new Map(), cwd }
        try {
          const connected = await mod.connectAgent(agent, { cwd })
          slot.connection = connected.connection
        } catch (error) {
          throw new Error('起 ACP agent 失败（' + agent.path + '）：' + messageOf(error))
        }
        acpConnections.set(agent.id, slot)
      }
      const existing = String(threadId || '')
      let sessionId = existing && slot.sessions.has(existing) ? String(slot.sessions.get(existing)) : ''
      if (!sessionId) {
        try {
          sessionId = await slot.connection.newSession(slot.cwd)
        } catch (error) {
          throw new Error('ACP 新建会话失败：' + messageOf(error))
        }
        slot.sessions.set(sessionId, sessionId)
      }
      let streamed = false
      const chunks = []
      const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 900_000
      const timer = setTimeout(() => {
        try { if (slot.connection) slot.connection.cancel(sessionId) } catch (error) { /* 忽略 */ }
      }, timeoutMs)
      if (timer.unref) timer.unref()
      let stopReason = 'end_turn'
      try {
        const result = await slot.connection.prompt(sessionId, text, {
          onChunk: chunk => {
            streamed = true
            chunks.push(chunk)
            if (typeof opts.onChunk === 'function') {
              try { opts.onChunk(chunk) } catch (error) { /* 面板断开不影响协议 */ }
            }
          },
        })
        stopReason = String((result && result.stopReason) || 'end_turn')
      } catch (error) {
        throw new Error('ACP 对话失败：' + messageOf(error))
      } finally {
        clearTimeout(timer)
      }
      const reply = chunks.join('')
      let thread = acpThreads.get(sessionId)
      if (!thread) {
        thread = {
          id: sessionId,
          agentId: agent.id,
          title: text.length > 30 ? text.slice(0, 30) : text,
          updatedAt: new Date().toISOString(),
          messages: [],
        }
        acpThreads.set(sessionId, thread)
        // 内存里只留最近 50 条线程，避免长期使用把 host 撑大
        while (acpThreads.size > 50) {
          const oldest = acpThreads.keys().next().value
          if (oldest === undefined || oldest === sessionId) break
          acpThreads.delete(oldest)
        }
      }
      thread.messages.push({ role: 'user', text })
      if (reply) thread.messages.push({ role: 'assistant', text: reply })
      thread.updatedAt = new Date().toISOString()
      return { threadId: sessionId, status: acpStatusOf(stopReason), reply, streamed }
    },
  }

  return { octop, dsh, acp }
}

/** ACP 源的 cwd：优先面板父会话的 cwd，否则进程 cwd。 */
function acpCwd(ctx, sessionId) {
  try {
    const parent = resolveParent(ctx, sessionId)
    const cwd = parent && parent.session && parent.session.header ? parent.session.header.cwd : ''
    if (cwd && typeof cwd === 'string') return cwd
  } catch (error) { /* 没有活会话也能跑，用进程 cwd */ }
  return process.cwd()
}

/** ACP 的 stopReason → 面板状态词。 */
function acpStatusOf(stopReason) {
  switch (String(stopReason || '')) {
    case 'end_turn': return 'completed'
    case 'max_tokens': return 'max-tokens'
    case 'cancelled': return 'aborted'
    case 'refusal': return 'refusal'
    default: return 'completed'
  }
}

/** 新线程：起一条 continuable 子会话，等它这一轮跑完。 */
async function startThread(ctx, subagents, parent, prompt, signal, timeoutMs, tap, threadParents, panelChildren) {
  const provider = pickProvider(subagents, true)
  let activation
  try {
    activation = await subagents.startActivation({
      provider,
      label: DSH_THREAD_LABEL,
      // 名字唯一且可读；不传的话 manager 自动起 agent-1/agent-2…
      // 用随机后缀而不是序号：重启后同一条父会话里的老子会话名字仍在，序号会撞。
      name: 'dsh-' + Math.random().toString(36).slice(2, 8),
      prompt: [{ type: 'text', text: prompt }],
      parent,
      signal,
      // caller：结果直接回给面板，不惊动父会话的模型；子会话仍进父 catalog
      delivery: 'caller',
    })
  } catch (error) {
    if (signal.aborted) throw new Error('请求已取消或超时（' + timeoutMs + 'ms）')
    throw new Error('起子 agent 失败：' + messageOf(error))
  }
  const childId = String(activation.childId || '')
  if (childId) {
    threadParents.set(childId, parent.id)
    if (panelChildren && typeof panelChildren.add === 'function') panelChildren.add(childId)
  }
  tap.setTarget(childId)
  // continuable 子会话的 activation.result 只在 dispose/teardown 时才 resolve，
  // 这里不能 await（会一直挂到父会话关掉）；改为等首轮 turn/end。
  if (activation && activation.result && typeof activation.result.catch === 'function') {
    void activation.result.catch(() => {})
  }
  const turn = await waitForTurn(ctx, childId, -1, signal, timeoutMs, subagents)
  let reply = turn.text
  if (!reply && tap && tap.hasText && tap.hasText()) reply = tap.text()
  if (!reply && turn.status !== 'completed') reply = '（这一轮以 ' + turn.status + ' 结束）'
  return { threadId: childId, status: turn.status, reply, streamed: Boolean(tap && tap.hasText && tap.hasText()) }
}

/** 老线程：往子会话投一条消息，等这轮 turn/end 后取最后一段 assistant 文本。 */
async function continueThread(ctx, subagents, parent, threadId, prompt, signal, timeoutMs, tap, didTimeout) {
  const baseline = await cursorOf(ctx, threadId)
  try {
    await subagents.sendMessage(parent, threadId, [{ type: 'text', text: prompt }], { signal })
  } catch (error) {
    const code = error && error.code ? String(error.code) : ''
    if (code === 'NOT_RESUMABLE' || code === 'UNAUTHORIZED' || code === 'CONTINUATION_UNAVAILABLE') {
      throw new Error('这条 DSH 线程续不了（' + code + '）：' + messageOf(error))
    }
    if (signal.aborted) throw new Error('请求已取消或超时（' + timeoutMs + 'ms）')
    throw new Error('给子 agent 发消息失败：' + messageOf(error))
  }

  const turn = await waitForTurn(ctx, threadId, baseline, signal, timeoutMs, subagents, didTimeout)
  let reply = turn.text
  if (!reply && tap && tap.hasText && tap.hasText()) reply = tap.text()
  if (!reply && turn.status !== 'completed') reply = '（这一轮以 ' + turn.status + ' 结束）'
  return { threadId, status: turn.status, reply, streamed: Boolean(tap && tap.hasText && tap.hasText()) }
}

/** 轮询子会话日志，等 baseline 之后的下一个 turn/end。 */
async function waitForTurn(ctx, sessionId, baseline, signal, timeoutMs, subagents, didTimeout) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (true) {
    if (signal.aborted) throw new Error('请求已取消或超时（' + timeoutMs + 'ms）')
    let turn = null
    try {
      turn = await readTurn(ctx, sessionId, baseline)
    } catch (error) {
      lastError = error
    }
    if (turn && turn.status) return turn
    if (Date.now() > deadline || (typeof didTimeout === 'function' && didTimeout())) {
      try { if (subagents && typeof subagents.interrupt === 'function') subagents.interrupt(sessionId, { kind: 'user' }) } catch (error) { /* 忽略 */ }
      throw new Error('等子 agent 回复超时（' + timeoutMs + 'ms）'
        + (lastError ? '：' + messageOf(lastError) : ''))
    }
    await sleep(DSH_POLL_MS)
  }
}

/** 读子会话当前最后一个事件 seq；空日志为 -1。 */
async function cursorOf(ctx, sessionId) {
  const observation = await observeSession(ctx, sessionId)
  try {
    const cursor = observation && observation.cursor
    return typeof cursor === 'number' ? cursor : -1
  } finally {
    releaseObservation(observation)
  }
}

/** 扫 baseline 之后的事件：拿最后一段 assistant 文本与最后一轮的 turn/end 状态。 */
async function readTurn(ctx, sessionId, baseline) {
  const observation = await observeSession(ctx, sessionId)
  try {
    const events = Array.isArray(observation && observation.events) ? observation.events : []
    let text = ''
    let status = ''
    for (const event of events) {
      if (!event || typeof event.seq !== 'number' || event.seq <= baseline) continue
      if (event.type === 'assistant/message') {
        const candidate = contentText(event.data && event.data.message && event.data.message.content)
        if (candidate) text = candidate
      } else if (event.type === 'turn/end') {
        status = stopReasonOf(event.data && event.data.reason)
      }
    }
    return { text, status }
  } finally {
    releaseObservation(observation)
  }
}
