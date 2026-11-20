/**
 * B 方案：只绑 127.0.0.1 的小 HTTP 桥，给面板取数据、发消息用。
 * 不依赖 cordis service 注册 / typert —— 面板直接 fetch 它。
 *
 * 多源：
 *   - 新路由 /api/<源>/experts|threads|history|chat|chat-stream|approve|status
 *   - 老路由 /experts /threads /history /chat /chat-stream /approve（默认 octop，
 *     面板不发 source 时行为不变）
 *   - GET 也可用 ?source=<源> 覆盖
 * dsh 源还认 `session`（父会话 id）：新线程挂在它下面；不给就取最近创建的活会话。
 */
import { createServer } from 'node:http'
import { wsTurn } from './ws.js'
import { createBackends, projectThread, projectHistory } from './backends.js'

const TOKEN = 'octop-bridge-7f3a9c'
const PORT = 8791
const CHAT_TIMEOUT_MS = 900_000

export { projectThread, projectHistory }

function send(res, code, value) {
  const body = JSON.stringify(value)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  })
  res.end(body)
}

/** 读请求体 JSON（限制 1MB）。 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
      catch (error) { reject(new Error('invalid JSON body')) }
    })
    req.on('error', reject)
  })
}

/** MCP CallToolResult -> 结构化对象。 */
function unwrap(result) {
  if (result && result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent
  const text = (result && Array.isArray(result.content) ? result.content : [])
    .filter(block => block && block.type === 'text').map(block => block.text).join('\n')
  if (!text) return {}
  try { const parsed = JSON.parse(text); if (parsed && typeof parsed === 'object') return parsed } catch (error) { /* 纯文本 */ }
  return { reply: text }
}

/** 从返回体里挑回复正文。 */
function pickReply(payload) {
  for (const key of ['response', 'reply', 'message', 'answer', 'content', 'text']) {
    const value = payload && payload[key]
    if (typeof value === 'string' && value) return value
  }
  return ''
}

/** 审批续跑：MCP 不行退 REST。 */
async function resume(client, agentId, threadId, decisions, timeoutMs) {
  const result = await client._raw('/api/agents/' + encodeURIComponent(agentId) + '/chat/hitl/resume', {
    method: 'POST', body: { thread_id: threadId, decisions }, timeoutMs,
  })
  if (!result.res.ok) throw new Error('审批续跑失败：HTTP ' + result.res.status + ' ' + String(result.text || '').slice(0, 200))
  const chunks = []
  for (const event of String(result.text || '').split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
    if (!data) continue
    try { const message = JSON.parse(data); if (message && typeof message.content === 'string') chunks.push(message.content) }
    catch (error) { chunks.push(data) }
  }
  return chunks.join('')
}

/**
 * 把路径拆成 { source, action }。
 * /api/dsh/threads -> { source:'dsh', action:'threads' }
 * /threads         -> { source:'', action:'threads' }（源交给 query/body）
 */
function routeOf(pathname) {
  const match = /^\/api\/([^/]+)(?:\/([^/]+))?\/?$/.exec(pathname)
  if (match) return { source: decodeURIComponent(match[1]), action: match[2] || '' }
  return { source: '', action: pathname.replace(/^\/+|\/+$/g, '') }
}

export function startBridge({ client, mcp, ctx }) {
  const backends = createBackends({ client, mcp, ctx })

  /** 源选择：路径前缀 > body.source > ?source= > octop。未知源回落到 octop。 */
  function backendOf(source, url, body) {
    const raw = String(source || (body && body.source) || (url && url.searchParams.get('source')) || 'octop')
    return backends[raw] || backends.octop
  }

  /** 面板当前打开的父会话 id（只有 dsh 源用）。 */
  function sessionOf(url, body) {
    const raw = (body && body.session) || (url && url.searchParams.get('session')) || ''
    return String(raw || '').trim()
  }

  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204, {})
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'unauthorized' })
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const route = routeOf(url.pathname)
      const path = route.action

      if (path === 'sources') {
        const list = await Promise.all(Object.values(backends).map(async b => ({ id: b.id, label: b.label, ...(await b.status()) })))
        return send(res, 200, list)
      }
      if (path === 'status') {
        const backend = backendOf(route.source, url)
        const state = await backend.status()
        return send(res, 200, { ...state, baseUrl: client.baseUrl, loggedIn: Boolean(client.token) })
      }
      if (path === 'experts') {
        return send(res, 200, await backendOf(route.source, url).listAgents())
      }
      if (path === 'threads') {
        const agentId = url.searchParams.get('agent')
        const rows = await backendOf(route.source, url).listThreads(String(agentId), { session: sessionOf(url) })
        return send(res, 200, Array.isArray(rows) ? rows : [])
      }
      if (path === 'history') {
        const agentId = url.searchParams.get('agent')
        const threadId = url.searchParams.get('thread')
        const rows = await backendOf(route.source, url).history(String(agentId), String(threadId), { session: sessionOf(url) })
        return send(res, 200, Array.isArray(rows) ? rows : [])
      }
      if (req.method === 'POST' && path === 'chat') {
        const body = await readJson(req)
        if (!body.agent || !body.prompt) return send(res, 400, { error: '需要 agent 和 prompt' })
        const backend = backendOf(route.source, url, body)
        if (backend.id === 'dsh') {
          const outcome = await backend.send(String(body.agent), String(body.thread || ''), String(body.prompt), {
            session: sessionOf(url, body),
            timeoutMs: Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : CHAT_TIMEOUT_MS,
          })
          return send(res, 200, {
            threadId: String(outcome.threadId || ''),
            threadChanged: false,
            status: String(outcome.status || 'completed'),
            reply: String(outcome.reply || ''),
            approval: '',
          })
        }
        const args = { expert_id: String(body.agent), message: String(body.prompt) }
        if (body.thread) args.thread_id = String(body.thread)
        let payload
        const threadChanged = false
        try {
          payload = unwrap(await mcp.callTool('call_octop_expert', args, { timeoutMs: CHAT_TIMEOUT_MS }))
        } catch (error) {
          // Octop 网关只允许续 MCP 自己创建的线程；遇到别的来源就新开一条。
          const message = error && error.message ? String(error.message) : ''
          if (!body.thread || !message.includes('MCP-created threads')) throw error
          // 非 MCP 线程：改走对话 WebSocket，保留原线程与上下文
          await client.ensureToken(false)
          const viaWs = await wsTurn({
            baseUrl: client.baseUrl, token: client.token,
            agentId: String(body.agent), threadId: String(body.thread), text: String(body.prompt),
          })
          return send(res, 200, { threadId: String(body.thread), threadChanged: false, status: 'completed', reply: viaWs.reply, approval: '' })
        }
        return send(res, 200, {
          threadId: String(payload.thread_id || (threadChanged ? '' : body.thread) || ''),
          threadChanged,
          status: String(payload.status || 'ok'),
          reply: pickReply(payload),
          approval: payload.approval ? JSON.stringify(payload.approval).slice(0, 4000) : '',
        })
      }
      if (req.method === 'POST' && path === 'approve') {
        const body = await readJson(req)
        if (!body.agent || !body.thread || !body.decision) return send(res, 400, { error: '需要 agent、thread、decision' })
        if (backendOf(route.source, url, body).id !== 'octop') return send(res, 400, { error: '这个源没有审批通道' })
        const decisions = [{ type: String(body.decision), ...(body.message ? { message: String(body.message) } : {}) }]
        let via = 'mcp'
        let reply = ''
        try {
          const payload = unwrap(await mcp.callTool('resume_octop_expert', {
            expert_id: String(body.agent), thread_id: String(body.thread), decisions,
          }, { timeoutMs: CHAT_TIMEOUT_MS }))
          reply = pickReply(payload)
        } catch (error) {
          via = 'rest'
          reply = await resume(client, String(body.agent), String(body.thread), decisions, CHAT_TIMEOUT_MS)
        }
        return send(res, 200, { via, reply })
      }

      if (req.method === 'POST' && path === 'chat-stream') {
        const body = await readJson(req)
        if (!body.agent || !body.prompt) return send(res, 400, { error: '需要 agent 和 prompt' })
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'access-control-allow-origin': '*',
        })
        const push = value => res.write('data: ' + JSON.stringify(value) + '\n\n')

        // dsh 源：真流式 —— 子 agent 的 text-delta 逐段透传；结束后补 done 帧。
        if (backendOf(route.source, url, body).id === 'dsh') {
          try {
            const outcome = await backends.dsh.send(String(body.agent), String(body.thread || ''), String(body.prompt), {
              session: sessionOf(url, body),
              timeoutMs: Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : CHAT_TIMEOUT_MS,
              onChunk: text => push({ chunk: text }),
            })
            // 流里没有任何增量（例如模型直出空回复）时，用最终正文兜底一次
            if (!outcome.streamed && outcome.reply) push({ chunk: outcome.reply })
            push({ done: true, threadId: String(outcome.threadId || ''), status: String(outcome.status || 'completed') })
          } catch (error) {
            push({ error: error && error.message ? String(error.message) : String(error) })
          }
          res.end()
          return
        }

        try {
          await client.ensureToken(false)
          await wsTurn({
            baseUrl: client.baseUrl, token: client.token,
            agentId: String(body.agent), threadId: body.thread ? String(body.thread) : '', text: String(body.prompt),
            onChunk: text => push({ chunk: text }),
          })
          // WS 流结束后查一次 history：有待审批就透传 approval 帧（WS 帧里不保证带审批结构）
          let approval = ''
          try {
            if (body.thread) {
              const data = await client.history(String(body.agent), String(body.thread), 5)
              const pending = data && (data.hitl_pending || data.hitl)
              if (pending) approval = JSON.stringify(pending).slice(0, 4000)
            }
          } catch (error) { /* 审批探测失败不影响正文 */ }
          if (approval) push({ approval })
          push({ done: true, threadId: String(body.thread || '') })
        } catch (error) {
          // WS 失败（常见：新对话没有 thread_id，服务端回 empty message）→ 用 MCP 开新线程兜底
          try {
            const payload = unwrap(await mcp.callTool('call_octop_expert', {
              expert_id: String(body.agent), message: String(body.prompt),
            }, { timeoutMs: CHAT_TIMEOUT_MS }))
            const reply = pickReply(payload)
            if (reply) push({ chunk: reply })
            if (payload && payload.approval) push({ approval: JSON.stringify(payload.approval).slice(0, 4000) })
            push({ done: true, threadId: String(payload.thread_id || ''), fallback: 'mcp' })
          } catch (fallbackError) {
            push({ error: 'WS 失败：' + (error && error.message ? error.message : error)
              + '；MCP 兜底也失败：' + (fallbackError && fallbackError.message ? fallbackError.message : fallbackError) })
          }
        }
        res.end()
        return
      }

      send(res, 404, { error: 'not found', action: path, source: route.source || 'octop' })
    } catch (error) {
      send(res, 500, { error: error && error.message ? error.message : String(error) })
    }
  })
  server.on('error', () => {})
  server.listen(PORT, '127.0.0.1')
  return server
}
