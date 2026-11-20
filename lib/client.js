/**
 * Octop REST 客户端：登录换 JWT、令牌缓存与提前续期、401 自动重登一次。
 *
 * 只用 Node 内置的 fetch / AbortSignal / Buffer，不引第三方依赖 —— 端侧（HarmonyOS）
 * 装不了带原生模块的包，插件必须是纯 JS。
 *
 * 接口契约来自 Octop 官方文档：
 *   POST /api/auth/login  {"username","password"} -> {"access_token","role","user"}
 *   之后每个请求带 Authorization: Bearer <access_token>，令牌默认 24h 过期。
 */

export class OctopError extends Error {
  /**
   * @param {string} message 给人看的中文原因
   * @param {{status?: number, code?: string, body?: unknown}} [detail]
   */
  constructor(message, detail) {
    super(message)
    this.name = 'OctopError'
    this.status = detail && detail.status
    this.code = detail && detail.code
    this.body = detail && detail.body
  }
}

/** Octop 官方错误码 -> 人话（登录相关）。 */
const AUTH_HINTS = {
  AUTH_FAILED: 'Octop 登录失败：用户名或密码不正确（AUTH_FAILED）。',
  LOGIN_LOCKED: 'Octop 账号已被锁定：连续登录失败次数过多（默认 5 次锁 15 分钟），等锁定期结束或让管理员解锁（LOGIN_LOCKED）。',
  USER_DISABLED: 'Octop 账号已被禁用，请联系管理员（USER_DISABLED）。',
  TOKEN_EXPIRED: 'Octop 令牌已过期（TOKEN_EXPIRED）。',
  FORBIDDEN: '当前 Octop 账号权限不足（FORBIDDEN），该操作需要更高权限。',
}

/**
 * 读 JWT 载荷（exp / role 都在里面）。读不出来返回 null，由调用方兜底。
 * @param {string} token
 * @returns {Record<string, any> | null}
 */
function decodeJwtPayload(token) {
  try {
    const payload = String(token).split('.')[1]
    if (!payload) return null
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const json = Buffer.from(normalized, 'base64').toString('utf8')
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** 默认配置；config 里没写的字段走这里。 */
export const CLIENT_DEFAULTS = {
  baseUrl: 'http://127.0.0.1:8088',
  username: '',
  password: '',
  timeoutMs: 60_000,
}

export class OctopClient {
  /** @param {Record<string, unknown>} config */
  constructor(config) {
    const merged = { ...CLIENT_DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
    this.baseUrl = String(merged.baseUrl || CLIENT_DEFAULTS.baseUrl).replace(/\/+$/, '')
    this.username = typeof merged.username === 'string' ? merged.username : ''
    this.password = typeof merged.password === 'string' ? merged.password : ''
    const timeout = Number(merged.timeoutMs)
    this.timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : CLIENT_DEFAULTS.timeoutMs

    /** @type {string} */
    this.token = ''
    /** @type {number} */
    this.tokenExpiresAt = 0
    /** @type {{id?: number, username?: string, display_name?: string} | null} */
    this.user = null
    /** @type {string} */
    this.role = ''
    /** @type {Promise<string> | null} */
    this._loginPromise = null
    /** @type {{at: number, agents: unknown[]} | null} */
    this._agentsCache = null
  }

  /** 凭据是否齐（缺了不阻止挂载，只在调用时给人话报错）。 */
  get configured() {
    return Boolean(this.username && this.password)
  }

  /** 登录并缓存令牌。并发调用共享同一个在途请求。 */
  async login() {
    if (!this.configured) {
      throw new OctopError('Octop 未配置：请在插件 config 里填 username 和 password（baseUrl 默认 http://127.0.0.1:8088）。')
    }
    const res = await this._raw('/api/auth/login', {
      method: 'POST',
      body: { username: this.username, password: this.password },
      auth: false,
      timeoutMs: Math.min(this.timeoutMs, 30_000),
    })
    if (!res.res.ok) {
      const code = codeOf(res.data)
      const hint = code && AUTH_HINTS[code] ? AUTH_HINTS[code] : `Octop 登录失败：HTTP ${res.res.status} ${snippet(res.data)}`
      throw new OctopError(hint, { status: res.res.status, code, body: res.data })
    }
    const token = res.data && res.data.access_token
    if (typeof token !== 'string' || token.length === 0) {
      throw new OctopError('Octop 登录响应里没有 access_token，可能版本不兼容。')
    }
    this.token = token
    const claims = decodeJwtPayload(token)
    const lifetime = Number(res.data && res.data.expires_in)
    this.tokenExpiresAt = claims && typeof claims.exp === 'number'
      ? claims.exp * 1000
      : Date.now() + (Number.isFinite(lifetime) && lifetime > 0 ? lifetime * 1000 : 24 * 60 * 60 * 1000)
    this.user = (res.data && res.data.user) || null
    // 真实响应是 {access_token, expires_in, token_type, user}，没有顶层 role；role 在 JWT 里。
    this.role = String((claims && claims.role) || (res.data && res.data.role) || '')
    return token
  }

  /**
   * 保证有可用令牌；剩余有效期不足 2 分钟就提前重登。
   * @param {boolean} [force]
   * @returns {Promise<string>}
   */
  async ensureToken(force) {
    if (!force && this.token && this.tokenExpiresAt - Date.now() > 120_000) return this.token
    if (!this._loginPromise) {
      this._loginPromise = this.login().finally(() => {
        this._loginPromise = null
      })
    }
    return this._loginPromise
  }

  /**
   * 带令牌的 JSON 请求；401 时重登并重试一次。
   * @param {string} path
   * @param {{method?: string, body?: unknown, timeoutMs?: number, signal?: AbortSignal, auth?: boolean}} [options]
   */
  async request(path, options = {}) {
    await this.ensureToken(false)
    let result = await this._raw(path, options)
    if (result.res.status === 401 && options.auth !== false) {
      await this.ensureToken(true)
      result = await this._raw(path, options)
    }
    if (!result.res.ok) {
      const code = codeOf(result.data)
      const hint = code && AUTH_HINTS[code] ? AUTH_HINTS[code] : `Octop 请求失败：HTTP ${result.res.status} ${path} ${snippet(result.data)}`
      throw new OctopError(hint, { status: result.res.status, code, body: result.data })
    }
    return result.data
  }

  /** 健康检查（公开接口，不需要令牌）。 */
  async health() {
    const res = await this._raw('/api/health', { method: 'GET', auth: false, timeoutMs: Math.min(this.timeoutMs, 15_000) })
    if (!res.res.ok) throw new OctopError(`Octop 健康检查失败：HTTP ${res.res.status}（${this.baseUrl}）`, { status: res.res.status })
    return res.data
  }

  /** 当前账号可见的专家。 */
  async listAgents() {
    const data = await this.request('/api/agents')
    return listOf(data, ['agents', 'items', 'data'])
  }

  /** 带 30s 缓存的专家列表（聊天前解析名字用，避免每次多打一次接口）。 */
  async listAgentsCached() {
    if (this._agentsCache && Date.now() - this._agentsCache.at < 30_000) return this._agentsCache.agents
    const agents = await this.listAgents()
    this._agentsCache = { at: Date.now(), agents }
    return agents
  }

  /** 某专家的对话线程列表。 */
  async listThreads(agentId, limit = 20) {
    const data = await this.request(`/api/agents/${encodeURIComponent(agentId)}/threads?limit=${encodeURIComponent(limit)}`)
    return listOf(data, ['threads', 'items', 'data'])
  }

  /** 某线程的历史消息（含 turn_active / hitl_pending）。 */
  async history(agentId, threadId, limit = 30, offset = 0) {
    const query = `?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`
    return this.request(`/api/agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(threadId)}/history${query}`)
  }

  /**
   * 底层：发一个请求并解析响应体（不判 ok，交给调用方）。
   * @returns {Promise<{res: Response, data: any, text: string}>}
   */
  async _raw(path, options = {}) {
    const url = this.baseUrl + path
    const headers = { accept: 'application/json' }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    if (options.auth !== false && this.token) headers.authorization = `Bearer ${this.token}`

    const budget = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : this.timeoutMs
    const timeout = AbortSignal.timeout(budget)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout

    let res
    try {
      res = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal,
      })
    } catch (cause) {
      const name = cause && cause.name
      if (name === 'AbortError' || name === 'TimeoutError') {
        throw new OctopError(`Octop 请求超时（${budget}ms）：${url}。可能是网络不通，或 Octop 正在忙。`)
      }
      throw new OctopError(`无法连接 Octop（${this.baseUrl}）：${cause && cause.message ? cause.message : cause}。检查 baseUrl、手机与 Octop 主机是否同网段、Octop 是否在运行。`)
    }

    const text = await res.text().catch(() => '')
    let data = null
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = text
      }
    }
    return { res, data, text }
  }
}

/** 从错误体里挖出 Octop 的错误码。 */
function codeOf(data) {
  if (!data || typeof data !== 'object') return ''
  if (typeof data.code === 'string') return data.code
  if (data.detail && typeof data.detail === 'object' && typeof data.detail.code === 'string') return data.detail.code
  if (typeof data.error === 'string') return data.error
  return ''
}

/** 把任意响应体压成一行短文本，用于错误消息。 */
function snippet(data) {
  const text = typeof data === 'string' ? data : JSON.stringify(data)
  return String(text == null ? '' : text).slice(0, 300)
}

/**
 * 把「数组 / {key: 数组}」两种返回形态统一成数组。
 * @param {any} data
 * @param {string[]} keys
 */
export function listOf(data, keys) {
  if (Array.isArray(data)) return data
  if (!data || typeof data !== 'object') return []
  for (const key of keys) {
    if (Array.isArray(data[key])) return data[key]
  }
  return []
}
