/**
 * ACP（Agent Client Protocol）客户端 —— 让面板能驱动外部 ACP agent
 * （Claude Code / Gemini CLI / Qwen Code 等）。
 *
 * 为什么自己写：核心的 `@deepseek-ai/dsh-acp` 是**服务端**（把 DSH 暴露成 ACP
 * agent），没有现成客户端；而插件又解析不到核心 node_modules 里的
 * `@agentclientprotocol/sdk`。这里只用 node 内置模块实现 ACP 需要的那一小撮：
 * NDJSON 分帧 + JSON-RPC 2.0 + initialize / session-new / session-prompt /
 * session-update / request-permission。
 *
 * 已知边界（端侧）：
 *   - 鸿蒙对应用创建进程有限制（HANDOFF 里的 E15：forkpty 失败），
 *     spawn 一个 CLI 大概率会失败；这里把错误原样抛给面板，不假装能用。
 *   - ACP agent 没有统一的历史读取接口，本文件的备份态只活在内存里（重启即丢）。
 *
 * 本模块按需动态 import（见 backends.js），即使这里写坏了也只影响 acp 源。
 */
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** 已知的 ACP agent 启动方式（命令名 -> 参数）。 */
export const KNOWN_AGENTS = [
  { id: 'claude', label: 'Claude Code', command: 'claude-code-acp', args: [] },
  { id: 'gemini', label: 'Gemini CLI', command: 'gemini', args: ['--experimental-acp'] },
  { id: 'qwen', label: 'Qwen Code', command: 'qwen', args: ['--experimental-acp'] },
]

/** 探测时额外扫的目录（端侧应用沙箱里常见的位置）。 */
const EXTRA_DIRS = ['/system/bin', '/usr/local/bin', '/usr/bin']

/** 默认的可执行判定：存在 + 普通文件（不做 X_OK，端侧沙箱里权限位常被抹掉）。 */
function defaultExists(path) {
  try { return existsSync(path) && statSync(path).isFile() } catch (error) { return false }
}

/**
 * 在 PATH 里找一个命令。
 * @param {string} command 命令名；带 `/` 时按路径处理
 * @param {string[]} dirs 搜索目录
 * @param {(path: string) => boolean} exists 可执行判定
 * @returns {string} 找到的绝对路径，或空串
 */
export function findExecutable(command, dirs, exists = defaultExists) {
  const name = String(command || '')
  if (!name) return ''
  if (name.includes('/')) return exists(name) ? name : ''
  for (const dir of dirs) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (exists(candidate)) return candidate
  }
  return ''
}

/**
 * 探测本机有哪些 ACP agent。
 * @param {{pathEnv?: string, extraDirs?: string[], exists?: (path: string) => boolean}} [options]
 * @returns {Array<{id: string, label: string, command: string, args: string[], path: string}>}
 */
export function detectAgents(options = {}) {
  const pathEnv = options.pathEnv !== undefined ? options.pathEnv : (process.env.PATH || '')
  const extraDirs = options.extraDirs !== undefined ? options.extraDirs : EXTRA_DIRS
  const exists = options.exists !== undefined ? options.exists : defaultExists
  const dirs = []
  for (const dir of String(pathEnv).split(delimiter)) if (dir) dirs.push(dir)
  for (const dir of extraDirs) if (dir && !dirs.includes(dir)) dirs.push(dir)
  const found = []
  for (const agent of KNOWN_AGENTS) {
    const path = findExecutable(agent.command, dirs, exists)
    if (path) found.push({ ...agent, path })
  }
  return found
}

/**
 * 一个 ACP 连接：子进程 + NDJSON 分帧 + 请求/通知分发。
 *
 * 生命周期：start() -> initialize() -> newSession()/prompt()... -> close()。
 * 任何一端断开时所有 pending 请求都会 reject，避免面板无限等。
 */
export class AcpConnection {
  /**
   * @param {{command: string, args?: string[], cwd?: string, env?: Record<string, string>, onPermission?: (request: any) => {optionId?: string}}} config
   */
  constructor(config) {
    this.config = config || {}
    this.child = null
    this.nextId = 1
    this.pending = new Map()
    this.buffer = ''
    this.closed = false
    this.exitError = null
    this.notificationHandler = null
  }

  /** 起子进程并挂上 stdout 读行。 */
  async start() {
    if (this.child) return
    const command = String(this.config.command || '')
    if (!command) throw new Error('ACP 连接缺少 command')
    const child = spawn(command, Array.isArray(this.config.args) ? this.config.args : [], {
      cwd: this.config.cwd || process.cwd(),
      env: { ...process.env, ...(this.config.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => this._feed(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { this.stderrTail = (String(this.stderrTail || '') + chunk).slice(-4000) })
    child.on('error', error => this._fail(error))
    child.on('exit', (code, signal) => {
      if (!this.closed) {
        const hint = this.stderrTail ? '：' + String(this.stderrTail).trim().split('\n').slice(-3).join(' | ') : ''
        this._fail(new Error('ACP agent 退出（code=' + code + ' signal=' + signal + '）' + hint))
      }
    })
  }

  /** 一条完整请求（带超时）。 */
  request(method, params, timeoutMs = 60_000) {
    if (!this.child) return Promise.reject(new Error('ACP 连接还没启动'))
    if (this.closed) return Promise.reject(this.exitError || new Error('ACP 连接已关闭'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('ACP 请求超时：' + method + '（' + timeoutMs + 'ms）'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this._write({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** 发通知（无 id）。 */
  notify(method, params) {
    this._write({ jsonrpc: '2.0', method, params })
  }

  /** 初始化握手。 */
  async initialize() {
    return await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    }, 30_000)
  }

  /** 新建会话，返回 sessionId。 */
  async newSession(cwd) {
    const response = await this.request('session/new', {
      cwd: String(cwd || this.config.cwd || process.cwd()),
      mcpServers: [],
    }, 60_000)
    const sessionId = response && (response.sessionId || (response.session && response.session.id))
    if (!sessionId) throw new Error('ACP session/new 没返回 sessionId')
    return String(sessionId)
  }

  /**
   * 发一轮 prompt。
   * @param {string} sessionId
   * @param {string} text
   * @param {{onChunk?: (text: string) => void, onUpdate?: (update: any) => void, signal?: AbortSignal}} [options]
   * @returns {Promise<{stopReason: string}>}
   */
  async prompt(sessionId, text, options = {}) {
    const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : null
    const onChunk = typeof options.onChunk === 'function' ? options.onChunk : null
    const previous = this.notificationHandler
    this.notificationHandler = (method, params) => {
      if (method !== 'session/update') return
      const update = params && params.update
      if (!update || String(params.sessionId || '') !== String(sessionId)) return
      if (onUpdate) { try { onUpdate(update) } catch (error) { /* 面板侧异常不影响协议 */ } }
      if (onChunk && update.sessionUpdate === 'agent_message_chunk') {
        const content = update.content
        if (content && content.type === 'text' && typeof content.text === 'string' && content.text) onChunk(content.text)
      }
    }
    try {
      const response = await this.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: String(text) }],
      }, 900_000)
      return { stopReason: String((response && response.stopReason) || 'end_turn') }
    } finally {
      this.notificationHandler = previous
    }
  }

  /** 取消当前轮（通知，无响应）。 */
  cancel(sessionId) {
    try { this.notify('session/cancel', { sessionId: String(sessionId) }) } catch (error) { /* 连接已断 */ }
  }

  /** 关连接：先礼后兵。 */
  close() {
    if (this.closed) return
    this.closed = true
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('ACP 连接已关闭'))
    }
    this.pending.clear()
    const child = this.child
    if (child) {
      try { child.stdin.end() } catch (error) { /* 已关 */ }
      try { child.kill() } catch (error) { /* 已退 */ }
    }
  }

  /** 断行缓冲 → 一行一个 JSON 对象。 */
  _feed(chunk) {
    this.buffer += chunk
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch (error) { continue }
      this._dispatch(message)
    }
  }

  /** 分发：响应 / 通知 / agent 发来的请求。 */
  _dispatch(message) {
    if (!message || typeof message !== 'object') return
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error('ACP 错误：' + (message.error.message || JSON.stringify(message.error))))
      else pending.resolve(message.result)
      return
    }
    if (message.id !== undefined && message.method) {
      this._handleAgentRequest(message)
      return
    }
    if (message.method) {
      if (this.notificationHandler) { try { this.notificationHandler(message.method, message.params) } catch (error) { /* 忽略 */ } }
    }
  }

  /** agent 发来的请求：默认策略是「能放行就放行，否则拒绝」。 */
  _handleAgentRequest(message) {
    const respond = result => this._write({ jsonrpc: '2.0', id: message.id, result })
    const fail = (code, text) => this._write({ jsonrpc: '2.0', id: message.id, error: { code, message: text } })
    try {
      if (message.method === 'session/request_permission') {
        const params = message.params || {}
        const options = Array.isArray(params.options) ? params.options : []
        let chosen = ''
        let permission = null
        if (typeof this.config.onPermission === 'function') {
          try { permission = this.config.onPermission(params) } catch (error) { permission = null }
        }
        if (permission && permission.optionId) chosen = String(permission.optionId)
        if (!chosen) {
          const preferred = options.find(option => option && (option.kind === 'allow_once' || option.kind === 'allow_always'))
          if (preferred && preferred.optionId) chosen = String(preferred.optionId)
        }
        if (!chosen) {
          respond({ outcome: { outcome: 'cancelled' } })
          return
        }
        respond({ outcome: { outcome: 'selected', optionId: chosen } })
        return
      }
      // 其它 agent→client 请求（fs/read_text_file、terminal/*）本端不支持，明确拒绝
      fail(-32601, 'method not supported by dsh-plugin-octop: ' + message.method)
    } catch (error) {
      try { fail(-32603, 'internal error') } catch (nested) { /* 连接已断 */ }
    }
  }

  /** 写一行 JSON。 */
  _write(message) {
    const child = this.child
    if (!child || this.closed) throw new Error('ACP 连接已关闭')
    child.stdin.write(JSON.stringify(message) + '\n')
  }

  /** 统一失败收尾。 */
  _fail(error) {
    if (this.closed) return
    this.closed = true
    this.exitError = error
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

/**
 * 起一个可用连接（initialize 已握手）。
 * @param {{id: string, path: string, args?: string[]}} agent detectAgents 的结果
 * @param {{cwd?: string, onPermission?: (request: any) => {optionId?: string}}} [options]
 */
export async function connectAgent(agent, options = {}) {
  const connection = new AcpConnection({
    command: agent.path,
    args: agent.args || [],
    cwd: options.cwd,
    onPermission: options.onPermission,
  })
  await connection.start()
  try {
    const init = await connection.initialize()
    return { connection, init }
  } catch (error) {
    connection.close()
    throw error
  }
}
