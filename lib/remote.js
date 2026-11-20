/**
 * Host 侧的 Remote 服务：把 Octop 数据暴露成客户端可调的 `ctx.remote.octop.*`。
 *
 * 不依赖任何 Service 基类（无论宿主那份还是拷贝那份），改为 `ctx.set()` 手动注册。
 * 网关的 collectSrcClaims 只认两件事：
 *   1. ctx.reflect.props 里 type === 'service' 的条目
 *   2. 该服务上有 `typertRemote` 绑定，且原型上有方法标记
 * 所以这里手工把这两样摆好，绕开 cordis 双实例带来的注册不确定性。
 *
 * 方法标记的键是字符串（不是 Symbol），因此与宿主那份 typert-protocol 天然对齐。
 */

import { OctopError } from './client.js'

const MARKER = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** 把线程行投影成面板要的形状（epoch 秒 -> ISO）。 */
function projectThread(row) {
  const id = row && (row.thread_id !== undefined ? row.thread_id : row.id)
  const lastActive = row && row.last_active
  return {
    id: String(id === undefined || id === null ? '' : id),
    title: String((row && (row.title || row.name)) || ''),
    updatedAt: typeof lastActive === 'number' && lastActive > 0 ? new Date(lastActive * 1000).toISOString() : '',
    active: Boolean(row && row.turn_active),
  }
}

/** 把历史消息投影成 {role, text}（只取 text 块，丢掉 thinking）。 */
function projectHistory(data) {
  const raw = data && Array.isArray(data.messages) ? data.messages : []
  const messages = raw.map(message => {
    const content = message && message.content
    let text = ''
    if (Array.isArray(content)) {
      text = content
        .filter(block => block && block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n')
    } else if (typeof content === 'string') {
      text = content
    }
    return { role: String((message && message.role) || 'unknown'), text }
  })
  return { messages, turnActive: Boolean(data && data.turn_active) }
}

/**
 * 构造 remote 服务对象并注册到 ctx。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('./client.js').OctopClient} client
 * @param {import('./mcp.js').OctopMcp} mcp
 */
export function installOctopRemote(ctx, client, mcp) {
  const service = {
    async status() {
      return { baseUrl: client.baseUrl, loggedIn: Boolean(client.token) }
    },
    async experts() {
      const list = await mcp.listExperts()
      return list.map(expert => ({
        id: expert.id,
        name: expert.name,
        description: expert.description,
        running: expert.running,
      }))
    },
    async threads(agentId) {
      if (!agentId) throw new OctopError('threads 需要 agentId')
      const rows = await client.listThreads(String(agentId), 30)
      return rows.map(projectThread)
    },
    async history(agentId, threadId) {
      if (!agentId || !threadId) throw new OctopError('history 需要 agentId 和 threadId')
      const data = await client.history(String(agentId), String(threadId), 50)
      return projectHistory(data)
    },
  }

  // 方法标记：网关按这个方法名清单一/一暴露成 octop/<method>
  Object.defineProperty(Object.getPrototypeOf(service), MARKER, {
    configurable: true,
    value: {
      version: 1,
      methods: ['status', 'experts', 'threads', 'history'].map(method => ({
        method,
        invocation: { kind: 'direct' },
      })),
    },
  })

  // 可见绑定：网关靠它拿命名空间
  Object.defineProperty(service, 'typertRemote', {
    configurable: true,
    value: Object.freeze({ service, serviceKey: 'octopRemote', namespace: 'octop' }),
  })

  // 手动注册成 service（不经过 Service 基类）
  ctx.set('octopRemote', service)
  return service
}
