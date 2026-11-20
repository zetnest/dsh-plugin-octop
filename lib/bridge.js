/**
 * B 方案：只绑 127.0.0.1 的小 HTTP 桥，给面板取 Octop 数据用。
 * 不依赖 cordis service 注册 / typert —— 面板直接 fetch 它。
 */
import { createServer } from 'node:http'
import { wsTurn } from './ws.js'
import { createBackends } from './backends.js'

const TOKEN = 'octop-bridge-7f3a9c'
const PORT = 8791

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

export function startBridge({ client, mcp }) {
  const backends = createBackends({ client, mcp })
  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204, {})
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'unauthorized' })
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (url.pathname === '/sources') {
        const list = await Promise.all(Object.values(backends).map(async b => ({ id: b.id, label: b.label, ...(await b.status()) })))
        return send(res, 200, list)
      }
      if (url.pathname === '/status') return send(res, 200, { baseUrl: client.baseUrl, loggedIn: Boolean(client.token) })
      if (url.pathname === '/experts') {
        return send(res, 200, await backends.octop.listAgents())
      }
      if (url.pathname === '/threads') {
        const agentId = url.searchParams.get('agent')
        const rows = await client.listThreads(String(agentId), 30)
        return send(res, 200, rows.map(projectThread))
      }
      if (url.pathname === '/history') {
        const agentId = url.searchParams.get('agent')
        const threadId = url.searchParams.get('thread')
        const data = await client.history(String(agentId), String(threadId), 50)
        return send(res, 200, projectHistory(data))
      }
      if (req.method === 'POST' && url.pathname === '/chat') {
        const body = await readJson(req)
        if (!body.agent || !body.prompt) return send(res, 400, { error: '需要 agent 和 prompt' })
        const args = { expert_id: String(body.agent), message: String(body.prompt) }
        if (body.thread) args.thread_id = String(body.thread)
        let payload
        let threadChanged = false
        try {
          payload = unwrap(await mcp.callTool('call_octop_expert', args, { timeoutMs: 900000 }))
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
      if (req.method === 'POST' && url.pathname === '/approve') {
        const body = await readJson(req)
        if (!body.agent || !body.thread || !body.decision) return send(res, 400, { error: '需要 agent、thread、decision' })
        const decisions = [{ type: String(body.decision), ...(body.message ? { message: String(body.message) } : {}) }]
        let via = 'mcp'
        let reply = ''
        try {
          const payload = unwrap(await mcp.callTool('resume_octop_expert', {
            expert_id: String(body.agent), thread_id: String(body.thread), decisions,
          }, { timeoutMs: 900000 }))
          reply = pickReply(payload)
        } catch (error) {
          via = 'rest'
          reply = await resume(client, String(body.agent), String(body.thread), decisions, 900000)
        }
        return send(res, 200, { via, reply })
      }

      if (req.method === 'POST' && url.pathname === '/chat-stream') {
        const body = await readJson(req)
        if (!body.agent || !body.prompt) return send(res, 400, { error: '需要 agent 和 prompt' })
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'access-control-allow-origin': '*',
        })
        const push = value => res.write('data: ' + JSON.stringify(value) + '\n\n')
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
            }, { timeoutMs: 900000 }))
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
      send(res, 404, { error: 'not found' })
    } catch (error) {
      send(res, 500, { error: error && error.message ? error.message : String(error) })
    }
  })
  server.on('error', () => {})
  server.listen(PORT, '127.0.0.1')
  return server
}
