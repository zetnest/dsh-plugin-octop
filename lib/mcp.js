/**
 * Octop Agent MCP 网关（streamable HTTP）的最小客户端。
 *
 * 端点：POST/GET/DELETE <baseUrl>/api/mcp/agents
 * 鉴权：Authorization: Bearer <JWT>（与 REST 同一个令牌）
 * 工具：list_octop_experts / call_octop_expert / resume_octop_expert
 *
 * 为什么不用 DSH 内置的 MCP 管理器：内置管理器是「一个 server 一组工具」的静态挂载，
 * 而这里要的是「按专家路由、把 thread_id / 审批状态翻成工具返回值」，还要跟 REST 的
 * 线程、历史共用同一个令牌。自己实现这层薄协议（initialize / tools/list / tools/call）
 * 比把 dsh-mcp-client 的内部 API 焊进插件更稳，也不跟核心版本耦合。
 *
 * 兼容性兜底：不同 Octop 版本的 inputSchema 属性名可能不同（expert_id / agent_id / id），
 * 调用前按实际 schema 做一次名字映射（见 tools.js 的 buildArguments）。
 */

import { OctopError } from './client.js'

/** 依次尝试的 MCP 协议版本（新 -> 旧）。 */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

/** 网关路径，集中在此处方便以后改。 */
const MCP_PATH = '/api/mcp/agents'

export class OctopMcp {
  /**
   * @param {import('./client.js').OctopClient} client
   * @param {{chatTimeoutMs?: number}} [options]
   */
  constructor(client, options = {}) {
    this.client = client
    this.path = MCP_PATH
    const chatTimeout = Number(options.chatTimeoutMs)
    this.chatTimeoutMs = Number.isFinite(chatTimeout) && chatTimeout > 0 ? chatTimeout : 900_000
    /** @type {string} */
    this.sessionId = ''
    /** @type {string} */
    this.protocolVersion = ''
    /** @type {Record<string, unknown> | null} */
    this.serverInfo = null
    this._nextId = 1
    /** @type {{at: number, tools: any[]} | null} */
    this._toolsCache = null
    /** @type {{at: number, experts: any[]} | null} */
    this._expertsCache = null
    /** @type {Promise<void> | null} */
    this._initPromise = null
  }

  /** 握过手没有。 */
  get ready() {
    return Boolean(this.protocolVersion)
  }

  /** 列出网关工具（带缓存，含 inputSchema，供参数名映射用）。 */
  async listTools() {
    if (this._toolsCache && Date.now() - this._toolsCache.at < 5 * 60_000) return this._toolsCache.tools
    await this.initialize()
    const result = await this._rpc('tools/list', {}, this.client.timeoutMs)
    const tools = result && Array.isArray(result.tools) ? result.tools : []
    this._toolsCache = { at: Date.now(), tools }
    return tools
  }

  /**
   * 调一个网关工具。
   * @param {string} name
   * @param {Record<string, unknown>} args
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
   * @returns {Promise<any>} MCP CallToolResult
   */
  async callTool(name, args, options = {}) {
    const tools = await this.listTools()
    const known = tools.find(tool => tool && tool.name === name)
    if (!known) {
      const available = tools.map(tool => tool && tool.name).filter(Boolean).join(', ')
      throw new OctopError(`Octop Agent MCP 没有工具「${name}」。当前可用：${available || '（无）'}。`)
    }
    const mapped = mapArguments(name, args, known.inputSchema)
    const timeout = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : this.chatTimeoutMs
    let result
    try {
      result = await this._rpc('tools/call', { name, arguments: mapped }, timeout, options.signal)
    } catch (cause) {
      // MCP 会话过期时服务端会报 session 相关错误：重置后重新握手再试一次。
      const message = cause && cause.message ? String(cause.message) : ''
      if (!/session/i.test(message)) throw cause
      this.reset()
      await this.initialize()
      result = await this._rpc('tools/call', { name, arguments: mapped }, timeout, options.signal)
    }
    if (result && result.isError) {
      const raw = textOfResult(result)
      let detail = raw
      try {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed.error === 'string') detail = parsed.error
      } catch {
        // 不是 JSON，直接用原文
      }
      throw new OctopError(`Octop 工具「${name}」执行失败：${String(detail || JSON.stringify(result)).slice(0, 500)}`)
    }
    return result
  }

  /**
   * 网关视角的专家列表（权威：只有这里列出的才能被 call_octop_expert 调用）。
   * 返回 [{id, name, description, model, running, shared, template}]。
   * 实测 kind=managed / kind=team 的 agent 不在网关里，REST /api/agents 却会列出来，
   * 所以 octop_chat 的专家解析要用这份，而不是 REST 列表。
   */
  async listExperts() {
    if (this._expertsCache && Date.now() - this._expertsCache.at < 30_000) return this._expertsCache.experts
    const result = await this.callTool('list_octop_experts', {}, { timeoutMs: this.client.timeoutMs })
    const payload = unwrapResult(result)
    const list = Array.isArray(payload.experts)
      ? payload.experts
      : Array.isArray(payload)
        ? payload
        : []
    const experts = list.map(entry => {
      const id = entry.expert_id !== undefined ? entry.expert_id : entry.id
      return {
        id: String(id === undefined || id === null ? '' : id),
        name: String(entry.name || entry.display_name || ''),
        description: String(entry.description || ''),
        model: String(entry.default_model || entry.model || ''),
        running: entry.state !== undefined ? entry.state === 'running' : Boolean(entry.running),
        shared: Boolean(entry.shared),
        template: String(entry.template_name || ''),
      }
    })
    this._expertsCache = { at: Date.now(), experts }
    return experts
  }

  /** 丢掉当前 MCP 会话（协议版本也一起丢，下次重新握手）。 */
  reset() {
    this.sessionId = ''
    this.protocolVersion = ''
    this.serverInfo = null
    this._toolsCache = null
    this._expertsCache = null
  }

  /** 初始化（只做一次；并发调用共享同一个在途握手）。 */
  async initialize() {
    if (this.ready) return
    if (!this._initPromise) {
      this._initPromise = this._handshake().finally(() => {
        this._initPromise = null
      })
    }
    return this._initPromise
  }

  /** 真正的握手：依次尝试协议版本，成功后发 notifications/initialized。 */
  async _handshake() {
    /** @type {unknown} */
    let lastError = null
    for (const version of PROTOCOL_VERSIONS) {
      const message = await this._post({
        jsonrpc: '2.0',
        id: this._nextId++,
        method: 'initialize',
        params: {
          protocolVersion: version,
          capabilities: {},
          clientInfo: { name: 'dsh-plugin-octop', version: '0.1.0' },
        },
      })
      if (message && message.result) {
        this.protocolVersion = typeof message.result.protocolVersion === 'string' ? message.result.protocolVersion : version
        this.serverInfo = message.result.serverInfo || null
        await this._post({ jsonrpc: '2.0', method: 'notifications/initialized' })
        return
      }
      lastError = message && message.error ? message.error : null
    }
    throw new OctopError(`Octop Agent MCP 握手失败：${JSON.stringify(lastError || {}).slice(0, 300)}。请确认 Octop 版本支持 Agent MCP（端点 ${this.client.baseUrl}${this.path}）。`)
  }

  /**
   * @param {string} method
   * @param {unknown} params
   * @param {number} timeoutMs
   * @param {AbortSignal} [signal]
   */
  async _rpc(method, params, timeoutMs, signal) {
    const id = this._nextId++
    const message = await this._post({ jsonrpc: '2.0', id, method, params }, { timeoutMs, signal })
    if (!message) throw new OctopError(`Octop Agent MCP 没有返回响应：${method}。`)
    if (message.error) {
      const detail = message.error && message.error.message ? message.error.message : JSON.stringify(message.error)
      throw new OctopError(`Octop Agent MCP 报错（${method}）：${detail}`)
    }
    return message.result
  }

  /**
   * 发一条 JSON-RPC 消息；通知（无 id）返回 null。
   * @param {Record<string, unknown>} payload
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
   */
  async _post(payload, options = {}) {
    const isNotification = payload.id === undefined
    const budget = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : this.client.timeoutMs
    const deadline = AbortSignal.timeout(budget)
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline

    for (let attempt = 0; attempt < 2; attempt++) {
      await this.client.ensureToken(attempt > 0)
      const headers = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${this.client.token}`,
      }
      if (this.sessionId) headers['mcp-session-id'] = this.sessionId
      if (this.protocolVersion) headers['mcp-protocol-version'] = this.protocolVersion

      let res
      try {
        res = await fetch(this.client.baseUrl + this.path, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal,
        })
      } catch (cause) {
        const name = cause && cause.name
        if (name === 'AbortError' || name === 'TimeoutError') {
          throw new OctopError(`Octop Agent MCP 请求超时（${budget}ms）。专家可能还在跑；稍后用 octop_history 查看线程结果。`)
        }
        throw new OctopError(`无法连接 Octop Agent MCP（${this.client.baseUrl}${this.path}）：${cause && cause.message ? cause.message : cause}`)
      }

      const sessionId = res.headers.get('mcp-session-id')
      if (sessionId) this.sessionId = sessionId

      if (res.status === 401 && attempt === 0) {
        await res.text().catch(() => '')
        continue
      }
      if (res.status === 404 || res.status === 405 || res.status === 501) {
        throw new OctopError(`Octop 没有可用的 Agent MCP 网关（${this.path} 返回 HTTP ${res.status}）。请确认 Octop 版本 ≥ 1.0.2，或在 config 里关掉 MCP 路径改用 REST。`, { status: res.status })
      }

      const contentType = res.headers.get('content-type') || ''
      const text = await res.text().catch(() => '')
      if (!res.ok) {
        throw new OctopError(`Octop Agent MCP 请求失败：HTTP ${res.status} ${text.slice(0, 300)}`, { status: res.status })
      }
      if (isNotification) return null
      if (text.length === 0) return null
      if (contentType.includes('text/event-stream')) {
        return pickSseMessage(text, payload.id)
      }
      try {
        return JSON.parse(text)
      } catch {
        return null
      }
    }
    throw new OctopError('Octop Agent MCP 认证失败：重登后仍然 401，检查账号权限。')
  }
}

/**
 * 从 SSE 文本里挑出 id 匹配的那条 JSON-RPC 响应。
 * @param {string} text
 * @param {number} id
 */
function pickSseMessage(text, id) {
  /** @type {any[]} */
  const messages = []
  for (const event of text.split(/\r?\n\r?\n/)) {
    const dataLines = []
    for (const line of event.split(/\r?\n/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
    }
    if (dataLines.length === 0) continue
    try {
      messages.push(JSON.parse(dataLines.join('\n')))
    } catch {
      // 忽略非 JSON 的 data 行（心跳等）
    }
  }
  const matched = messages.find(message => message && message.id === id)
  if (matched) return matched
  return messages.length > 0 ? messages[messages.length - 1] : null
}

/**
 * 不同版本 CallToolResult 的文本提取。
 * @param {any} result
 */
export function textOfResult(result) {
  if (!result || !Array.isArray(result.content)) return ''
  return result.content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/**
 * 把 CallToolResult 拆成结构化对象：优先 structuredContent，其次把文本当 JSON 解析，
 * 都不行就当成纯文本回复。适配「专家回复 JSON / 纯文本」两种服务端形态。
 * @param {any} result
 * @returns {Record<string, any>}
 */
export function unwrapResult(result) {
  if (result && result.structuredContent && typeof result.structuredContent === 'object') {
    return { ...result.structuredContent }
  }
  const text = textOfResult(result)
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    if (Array.isArray(parsed)) return { reply: text }
  } catch {
    // 不是 JSON，按纯文本回复
  }
  return { reply: text }
}

/**
 * 按网关实际的 inputSchema 映射参数名：Octop 各版本可能叫 expert_id / agent_id / id，
 * message / prompt / content。只传 schema 认得的字段，避免被服务端拒。
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 * @param {any} inputSchema
 * @returns {Record<string, unknown>}
 */
export function mapArguments(toolName, args, inputSchema) {
  const properties = inputSchema && inputSchema.properties && typeof inputSchema.properties === 'object'
    ? inputSchema.properties
    : null
  if (!properties) return args
  const names = Object.keys(properties)
  /** @type {Record<string, string[]>} */
  const aliases = {
    expert_id: ['expert_id', 'agent_id', 'expert', 'agent', 'id'],
    message: ['message', 'prompt', 'content', 'text', 'query', 'input'],
    thread_id: ['thread_id', 'threadId', 'thread', 'conversation_id', 'session_id'],
    decisions: ['decisions', 'approval_decisions', 'answers', 'responses'],
  }
  /** @type {Record<string, unknown>} */
  const mapped = {}
  for (const key of Object.keys(args)) {
    const value = args[key]
    if (value === undefined || value === null || value === '') continue
    const candidates = aliases[key] || [key]
    const hit = candidates.find(candidate => names.includes(candidate))
    if (!hit) continue
    mapped[hit] = coerce(value, properties[hit])
  }
  if (toolName === 'resume_octop_expert' && mapped.decisions === undefined) {
    // 有的版本要求 decisions 必填且形如 [{type, message}]
    mapped.decisions = Array.isArray(args.decisions) ? args.decisions : [{ type: 'approve' }]
  }
  return mapped
}

/**
 * 按 JSON Schema 的 type 做最小强制转换（专家 id 常见为 integer）。
 * @param {unknown} value
 * @param {any} schema
 */
function coerce(value, schema) {
  const type = schema && schema.type
  if (type === 'integer' || type === 'number') {
    const numeric = Number(value)
    return Number.isFinite(numeric) ? numeric : value
  }
  if (type === 'string' && typeof value !== 'string') return String(value)
  return value
}
