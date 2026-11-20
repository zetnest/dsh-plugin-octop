/**
 * 六个模型可见工具的注册定义（纯对象，不依赖 dsh-tools 的 defineTool）。
 *
 * 端侧装包只能装纯 JS，且第三方插件解析不到核心包的 node_modules，所以这里
 * 直接产出 registry 认的 ToolDefinition 形状：parameters / output.schema 都用
 * 完整 JSON Schema（DSH 只支持 type/oneOf/properties/required/additionalProperties/
 * items/enum/const + 注解关键字；required 必须是字符串数组）。注册前 registry 会
 * 强校验 output.schema，参数校验在 execute 里做（缺参给人话，不抛难懂的 schema 错）。
 */

import { OctopError, listOf } from './client.js'
import { unwrapResult } from './mcp.js'

/** 专家对象的统一投影。 */
function normalizeAgent(raw) {
  if (!raw || typeof raw !== 'object') return { id: '', numericId: '', name: '', description: '', model: '', running: false }
  // 真实契约（Octop 1.0.3b7 实测）：MCP 的 expert_id 与 REST 的 /api/agents/{agent_id}
  // 都用 agent_id 字符串（如 "TEGCKN"），数字 id 只出现在部分响应里，留作匹配别名。
  const primary = raw.agent_id !== undefined && raw.agent_id !== null && raw.agent_id !== '' ? raw.agent_id : raw.id
  const name = raw.name || raw.display_name || raw.title || (primary !== undefined ? `专家 ${primary}` : '未命名专家')
  const running = raw.running !== undefined
    ? Boolean(raw.running)
    : typeof raw.state === 'string' ? raw.state === 'running' : false
  return {
    id: String(primary === undefined || primary === null ? '' : primary),
    numericId: String(raw.id === undefined || raw.id === null ? '' : raw.id),
    name: String(name),
    description: String(raw.description || ''),
    model: String(raw.default_model || raw.model || ''),
    running,
    kind: String(raw.kind || ''),
  }
}

/** 线程对象的统一投影（last_active 是 epoch 秒，转成 ISO 更好读）。 */
function normalizeThread(raw) {
  if (!raw || typeof raw !== 'object') return { id: '', title: '', updated_at: '' }
  const id = raw.thread_id !== undefined ? raw.thread_id : raw.id
  let updatedAt = raw.updated_at || raw.updatedAt || ''
  if (!updatedAt && typeof raw.last_active === 'number' && raw.last_active > 0) {
    updatedAt = new Date(raw.last_active * 1000).toISOString()
  }
  return {
    id: String(id === undefined || id === null ? '' : id),
    title: String(raw.title || raw.name || ''),
    updated_at: String(updatedAt),
  }
}

/** 任意值 -> 可读文本（数组拼接、对象优先取 .text / .content）。 */
function textOf(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(item => textOf(item)).filter(Boolean).join('\n')
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    if (typeof value.content === 'string') return value.content
    try {
      return JSON.stringify(value)
    } catch {
      return ''
    }
  }
  return ''
}

/** 从网关返回体里挑出「回复正文」。 */
function pickReply(payload) {
  if (!payload || typeof payload !== 'object') return textOf(payload)
  const keys = ['reply', 'message', 'answer', 'content', 'output', 'text', 'result', 'response']
  for (const key of keys) {
    const text = textOf(payload[key])
    if (text) return text
  }
  return textOf(payload)
}

/** 专家列表压成一行，用于报错时的候选提示。 */
function agentListText(agents) {
  if (agents.length === 0) return '（当前账号看不到任何专家）'
  return agents.map(agent => `${agent.name}(id=${agent.id})`).join('，')
}

/**
 * 把 expert 参数解析成具体专家。以 Agent MCP 网关的列表为准（只有 kind=expert 能调），
 * 支持 agent_id、名称全名与唯一子串；缺省时用 config.defaultExpert，只有一个时直接用它。
 * @param {import('./client.js').OctopClient} client
 * @param {unknown} ref
 * @param {string} fallback
 * @param {import('./mcp.js').OctopMcp} mcp
 */
async function resolveExpert(client, ref, fallback, mcp) {
  const wanted = ref === undefined || ref === null || String(ref).trim() === '' ? fallback : String(ref).trim()
  /** @type {any[]} */
  let experts
  try {
    experts = await mcp.listExperts()
  } catch {
    // 网关不可用时退回 REST 列表（至少还能报出候选，不至于整条链路挂掉）
    experts = (await client.listAgentsCached()).map(normalizeAgent)
  }
  if (!wanted) {
    if (experts.length === 1) return experts[0]
    throw new OctopError(`请指定 expert（专家名或 agent_id）。可调用的专家：${agentListText(experts)}`)
  }
  const lower = wanted.toLowerCase()
  const byId = experts.find(agent => agent.id === wanted)
  if (byId) return byId
  const exact = experts.find(agent => agent.name.toLowerCase() === lower)
  if (exact) return exact
  const partial = experts.filter(agent => agent.name.toLowerCase().includes(lower))
  if (partial.length === 1) return partial[0]
  if (partial.length > 1) {
    throw new OctopError(`专家名「${wanted}」匹配到多个：${partial.map(agent => `${agent.name}(agent_id=${agent.id})`).join('，')}。请改用 agent_id。`)
  }
  // 不在网关里：查 REST 列表，区分「根本没这个专家」和「类型不支持 MCP 调用」。
  /** @type {any[]} */
  let known = []
  try {
    known = (await client.listAgentsCached()).map(normalizeAgent)
  } catch {
    known = []
  }
  const other = known.find(agent => agent.id === wanted
    || (agent.numericId !== '' && agent.numericId === wanted)
    || agent.name.toLowerCase() === lower)
  if (other) {
    throw new OctopError(`「${other.name}」(agent_id=${other.id}) 的类型是 ${other.kind || 'unknown'}，Agent MCP 网关只开放 kind=expert 的专家，octop_chat / octop_approve 调不了它。可调用的专家：${agentListText(experts)}`)
  }
  throw new OctopError(`找不到专家「${wanted}」。可调用的专家：${agentListText(experts)}`)
}

/**
 * 历史消息的正文提取：content 是 block 数组（text / thinking / tool_use…），
 * 只取 text 块拼起来；一个 text 块都没有时才退回整段 JSON（保留信息不丢）。
 */
function contentText(content) {
  if (Array.isArray(content)) {
    const texts = content
      .filter(block => block && block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
    if (texts.length > 0) return texts.join('\n')
    return content.map(block => textOf(block)).filter(Boolean).join('\n')
  }
  return textOf(content)
}

/** 历史消息的统一投影。 */
function messagesOf(data) {
  const list = listOf(data, ['messages', 'items', 'history', 'turns'])
  const messages = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') {
      messages.push({ role: 'unknown', content: textOf(raw) })
      continue
    }
    const role = String(raw.role || raw.type || raw.sender || 'unknown')
    const content = contentText(raw.content !== undefined ? raw.content : (raw.text !== undefined ? raw.text : raw.parts))
    messages.push({ role, content })
  }
  return messages
}

/** 解析 SSE 响应里的文本（审批续跑走 SSE）。 */
function sseText(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  const chunks = []
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, ''))
      .join('\n')
    if (!data) continue
    try {
      const message = JSON.parse(data)
      if (message && typeof message.content === 'string') chunks.push(message.content)
      else if (message && message.type === 'error') chunks.push(`[Octop 错误] ${message.message || ''}`)
      else if (message && typeof message.reply === 'string') chunks.push(message.reply)
    } catch {
      chunks.push(data)
    }
  }
  return chunks.join('')
}

/** 审批续跑：MCP 走不通时退回 REST（文档里的 hitl/resume）。 */
async function resumeViaRest(client, agentId, threadId, decisions, timeoutMs) {
  const { res, text } = await client._raw(`/api/agents/${encodeURIComponent(agentId)}/chat/hitl/resume`, {
    method: 'POST',
    body: { thread_id: threadId, decisions },
    timeoutMs,
  })
  if (!res.ok) {
    throw new OctopError(`审批续跑失败：HTTP ${res.status} ${String(text).slice(0, 300)}`, { status: res.status })
  }
  return sseText(text) || String(text || '').slice(0, 2000)
}

/** 对象 schema 简写：属性都在 props，required 单独给数组。 */
function objectSchema(properties, required) {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required && required.length > 0 ? { required } : {}),
  }
}

/** 数组 schema 简写。 */
function arraySchema(items) {
  return { type: 'array', items }
}

/**
 * 构造全部工具定义。
 * @param {{client: import('./client.js').OctopClient, mcp: import('./mcp.js').OctopMcp, config: any}} deps
 */
export function createToolDefinitions({ client, mcp, config }) {
  const chatTimeoutMs = Number(config.chatTimeoutMs) > 0 ? Number(config.chatTimeoutMs) : 900_000

  const agentBriefSchema = objectSchema({
    id: { type: 'string' },
    name: { type: 'string' },
  }, ['id', 'name'])

  return [
    {
      name: 'octop_status',
      description: '检查 Octop 连接状态（baseUrl 是否可达、当前登录账号、可见专家、Agent MCP 网关是否可用）。配置完插件或用 octop_chat 报错时先用它自检。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: objectSchema({
          base_url: { type: 'string' },
          version: { type: 'string' },
          logged_in: { type: 'boolean' },
          user: { type: 'string' },
          role: { type: 'string' },
          mcp_ok: { type: 'boolean' },
          error: { type: 'string' },
          experts: arraySchema(agentBriefSchema),
        }, ['base_url', 'logged_in']),
        render: (_args, value) => {
          const lines = [`Octop: ${value.base_url}`]
          if (value.version) lines.push(`版本: ${value.version}`)
          lines.push(value.logged_in ? `登录: ${value.user || '(已登录)'}${value.role ? `（${value.role}）` : ''}` : '登录: 失败')
          if (value.mcp_ok !== undefined) lines.push(`Agent MCP: ${value.mcp_ok ? '可用' : '不可用'}`)
          if (value.error) lines.push(`错误: ${value.error}`)
          if (value.experts && value.experts.length > 0) {
            lines.push('专家:', ...value.experts.map(agent => `  - ${agent.name} (id=${agent.id})`))
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute() {
        /** @type {Record<string, unknown>} */
        const output = { base_url: client.baseUrl, logged_in: false }
        try {
          const health = await client.health()
          if (health && typeof health === 'object' && typeof health.version === 'string') output.version = health.version
        } catch (cause) {
          output.error = cause && cause.message ? cause.message : String(cause)
          return output
        }
        try {
          await client.ensureToken(false)
          output.logged_in = true
          output.user = client.user && (client.user.display_name || client.user.username)
            ? String(client.user.display_name || client.user.username)
            : client.username
          output.role = String(client.role || '')
        } catch (cause) {
          output.error = cause && cause.message ? cause.message : String(cause)
          return output
        }
        try {
          const experts = await mcp.listExperts()
          output.experts = experts.map(agent => ({ id: agent.id, name: agent.name }))
        } catch {
          try {
            const agents = (await client.listAgents()).map(normalizeAgent)
            output.experts = agents.map(agent => ({ id: agent.id, name: agent.name }))
          } catch (cause) {
            output.error = cause && cause.message ? cause.message : String(cause)
          }
        }
        try {
          await mcp.listTools()
          output.mcp_ok = true
          if (mcp.serverInfo && mcp.serverInfo.version) output.version = String(mcp.serverInfo.version)
        } catch {
          output.mcp_ok = false
        }
        return output
      },
    },

    {
      name: 'octop_experts',
      description: '列出当前 Octop 账号可见的专家（id、名称、描述、默认模型、是否运行中），用于决定 octop_chat 要调哪个专家。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: objectSchema({
          experts: arraySchema(objectSchema({
            id: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            model: { type: 'string' },
            running: { type: 'boolean' },
            kind: { type: 'string' },
          }, ['id', 'name'])),
        }, ['experts']),
        render: (_args, value) => {
          if (value.experts.length === 0) return [{ type: 'text', text: '当前 Octop 账号看不到可调用的专家。' }]
          const lines = value.experts.map(agent => {
            const tail = [agent.model ? `模型 ${agent.model}` : '', agent.running ? '运行中' : '', agent.kind && agent.kind !== 'expert' ? agent.kind : ''].filter(Boolean).join('，')
            return `- ${agent.name} (agent_id=${agent.id})${agent.description ? `：${agent.description}` : ''}${tail ? ` [${tail}]` : ''}`
          })
          return [{ type: 'text', text: `Octop 可调用专家（${value.experts.length}）：\n${lines.join('\n')}` }]
        },
      },
      async execute() {
        /** @type {any[]} */
        let experts
        try {
          experts = await mcp.listExperts()
        } catch {
          // 网关不可用时退回 REST，至少能看到账号下有哪些 agent
          experts = (await client.listAgents()).map(normalizeAgent)
        }
        return {
          experts: experts.map(agent => ({
            id: agent.id,
            name: agent.name,
            description: agent.description,
            model: agent.model,
            running: agent.running,
            kind: agent.kind || 'expert',
          })),
        }
      },
    },

    {
      name: 'octop_chat',
      description: '让 Octop 里某个专家跑一轮对话并返回回复。expert 传专家名或 id；传 thread_id 表示在该线程里续聊，不传就是新开一段对话。返回的 thread_id 请保留，续聊或查历史时用。若回复 status=approval_required，说明专家在等工具审批，用 octop_approve 提交决定。',
      parameters: {
        type: 'object',
        properties: {
          expert: { type: 'string', description: '专家名称或 id；省略则用插件配置的 defaultExpert（只配了一个专家时可省略）。' },
          prompt: { type: 'string', description: '发给专家的任务/问题。' },
          thread_id: { type: 'string', description: '可选：已有线程 id，传了就续聊；省略则新开线程。' },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      output: {
        schema: objectSchema({
          expert: { type: 'string' },
          expert_id: { type: 'string' },
          thread_id: { type: 'string' },
          status: { type: 'string' },
          reply: { type: 'string' },
          approval: { type: 'string' },
        }, ['expert', 'expert_id', 'thread_id', 'status', 'reply']),
        render: (_args, value) => {
          const parts = []
          parts.push(value.status === 'approval_required'
            ? `Octop 专家「${value.expert}」需要审批后才能继续：`
            : `Octop 专家「${value.expert}」回复：`)
          parts.push(value.reply || '（专家没有返回文本）')
          if (value.approval) parts.push(`审批详情：${value.approval}`)
          if (value.thread_id) parts.push(`thread_id: ${value.thread_id}（续聊/查历史时传回）`)
          return [{ type: 'text', text: parts.join('\n\n') }]
        },
      },
      async execute(rawArgs, exec) {
        const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
        const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
        if (!prompt) throw new OctopError('octop_chat 需要 prompt（非空字符串）。')
        const expert = await resolveExpert(client, args.expert, config.defaultExpert, mcp)
        /** @type {Record<string, unknown>} */
        const callArgs = { expert_id: expert.id, message: prompt }
        if (typeof args.thread_id === 'string' && args.thread_id) callArgs.thread_id = args.thread_id

        const result = await mcp.callTool('call_octop_expert', callArgs, {
          timeoutMs: chatTimeoutMs,
          signal: exec && exec.signal,
        })
        const payload = unwrapResult(result)
        const threadId = textOf(payload.thread_id || payload.threadId || payload.thread || payload.conversation_id)
        const status = textOf(payload.status || payload.state) || 'ok'
        const reply = pickReply(payload)
        const approval = payload && payload.approval ? textOf(payload.approval).slice(0, 4000) : ''

        /** @type {Record<string, unknown>} */
        const output = { expert: expert.name, expert_id: expert.id, thread_id: threadId, status, reply }
        if (approval) output.approval = approval
        return output
      },
    },

    {
      name: 'octop_threads',
      description: '列出某个 Octop 专家的对话线程（按最近更新），拿到 thread_id 后可查历史或续聊。',
      parameters: {
        type: 'object',
        properties: {
          expert: { type: 'string', description: '专家名称或 id；省略则用配置的 defaultExpert。' },
          limit: { type: 'integer', description: '最多返回多少条，默认 20。' },
        },
        additionalProperties: false,
      },
      output: {
        schema: objectSchema({
          expert: { type: 'string' },
          expert_id: { type: 'string' },
          threads: arraySchema(objectSchema({
            id: { type: 'string' },
            title: { type: 'string' },
            updated_at: { type: 'string' },
          }, ['id'])),
        }, ['expert', 'expert_id', 'threads']),
        render: (_args, value) => {
          if (value.threads.length === 0) return [{ type: 'text', text: `专家「${value.expert}」还没有对话线程。` }]
          const lines = value.threads.map(thread => `- ${thread.title || '(无标题)'} — ${thread.id}${thread.updated_at ? `（${thread.updated_at}）` : ''}`)
          return [{ type: 'text', text: `专家「${value.expert}」的线程（${value.threads.length}）：\n${lines.join('\n')}` }]
        },
      },
      async execute(rawArgs) {
        const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
        const expert = await resolveExpert(client, args.expert, config.defaultExpert, mcp)
        const limit = Number(args.limit) > 0 ? Math.min(Math.floor(Number(args.limit)), 100) : 20
        const raw = await client.listThreads(expert.id, limit)
        return {
          expert: expert.name,
          expert_id: expert.id,
          threads: raw.map(normalizeThread).slice(0, limit),
        }
      },
    },

    {
      name: 'octop_history',
      description: '读取某个 Octop 线程的历史消息，并报告该线程是否还在运行（turn_active）以及是否有待审批（hitl_pending）。',
      parameters: {
        type: 'object',
        properties: {
          expert: { type: 'string', description: '专家名称或 id；省略则用配置的 defaultExpert。' },
          thread_id: { type: 'string', description: '线程 id（octop_chat / octop_threads 返回）。' },
          limit: { type: 'integer', description: '最多返回多少条消息，默认 30。' },
        },
        required: ['thread_id'],
        additionalProperties: false,
      },
      output: {
        schema: objectSchema({
          expert: { type: 'string' },
          thread_id: { type: 'string' },
          turn_active: { type: 'boolean' },
          hitl_pending: { type: 'string' },
          messages: arraySchema(objectSchema({
            role: { type: 'string' },
            content: { type: 'string' },
          }, ['role', 'content'])),
        }, ['expert', 'thread_id', 'turn_active', 'messages']),
        render: (_args, value) => {
          const parts = [`线程 ${value.thread_id}${value.turn_active ? '（专家正在运行）' : ''}`]
          if (value.hitl_pending) parts.push(`待审批：${value.hitl_pending}`)
          if (value.messages.length === 0) {
            parts.push('（没有消息）')
          } else {
            parts.push(value.messages.map(message => `[${message.role}] ${message.content}`).join('\n\n'))
          }
          return [{ type: 'text', text: parts.join('\n\n') }]
        },
      },
      async execute(rawArgs) {
        const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
        const threadId = typeof args.thread_id === 'string' ? args.thread_id.trim() : ''
        if (!threadId) throw new OctopError('octop_history 需要 thread_id。')
        const expert = await resolveExpert(client, args.expert, config.defaultExpert, mcp)
        const limit = Number(args.limit) > 0 ? Math.min(Math.floor(Number(args.limit)), 200) : 30
        const data = await client.history(expert.id, threadId, limit)
        const turnActive = Boolean(data && (data.turn_active !== undefined ? data.turn_active : data.turnActive))
        const hitl = data && (data.hitl_pending || data.hitl)
        /** @type {Record<string, unknown>} */
        const output = {
          expert: expert.name,
          thread_id: threadId,
          turn_active: turnActive,
          messages: messagesOf(data),
        }
        if (hitl) output.hitl_pending = textOf(hitl).slice(0, 4000)
        return output
      },
    },

    {
      name: 'octop_approve',
      description: '当 octop_chat 返回 status=approval_required（或 octop_history 显示 hitl_pending）时，用它在同一线程里提交审批决定并继续这一轮。decision 取 approve/reject/respond；respond 时用 message 回答问题。',
      parameters: {
        type: 'object',
        properties: {
          expert: { type: 'string', description: '专家名称或 id；省略则用配置的 defaultExpert。' },
          thread_id: { type: 'string', description: '被挂起的那条线程 id。' },
          decision: {
            type: 'string',
            enum: ['approve', 'reject', 'respond'],
            description: 'approve=允许工具动作；reject=拒绝；respond=回答专家的提问（配合 message）。',
          },
          message: { type: 'string', description: 'decision=respond 时的回答内容；approve/reject 可省略。' },
        },
        required: ['thread_id', 'decision'],
        additionalProperties: false,
      },
      output: {
        schema: objectSchema({
          expert: { type: 'string' },
          thread_id: { type: 'string' },
          decision: { type: 'string' },
          via: { type: 'string' },
          reply: { type: 'string' },
        }, ['expert', 'thread_id', 'decision', 'via', 'reply']),
        render: (_args, value) => {
          const head = `已向专家「${value.expert}」提交审批决定：${value.decision}（通道 ${value.via}）`
          const body = value.reply ? `专家继续执行后的输出：\n\n${value.reply}` : '专家没有返回新文本，可用 octop_history 查看线程状态。'
          return [{ type: 'text', text: `${head}\n\n${body}` }]
        },
      },
      async execute(rawArgs, exec) {
        const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
        const threadId = typeof args.thread_id === 'string' ? args.thread_id.trim() : ''
        if (!threadId) throw new OctopError('octop_approve 需要 thread_id。')
        const decision = String(args.decision || 'approve')
        const message = typeof args.message === 'string' ? args.message : ''
        if (decision === 'respond' && !message) throw new OctopError('decision=respond 时必须提供 message。')
        const expert = await resolveExpert(client, args.expert, config.defaultExpert, mcp)
        const decisions = [{ type: decision, ...(message ? { message } : {}) }]

        /** @type {'mcp' | 'rest'} */
        let via = 'mcp'
        let reply = ''
        try {
          const result = await mcp.callTool('resume_octop_expert', {
            expert_id: expert.id,
            thread_id: threadId,
            decisions,
          }, { timeoutMs: chatTimeoutMs, signal: exec && exec.signal })
          reply = pickReply(unwrapResult(result))
        } catch (cause) {
          via = 'rest'
          reply = await resumeViaRest(client, expert.id, threadId, decisions, chatTimeoutMs)
          if (!reply) {
            reply = cause && cause.message ? `（MCP 续跑失败：${cause.message}；已改用 REST，但没有拿到文本）` : ''
          }
        }
        return { expert: expert.name, thread_id: threadId, decision, via, reply }
      },
    },
  ]
}
