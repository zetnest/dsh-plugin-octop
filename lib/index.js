/**
 * dsh-plugin-octop —— 在 DSH 里操作 Octop。
 *
 * 一个 cordis 插件：注入 `tools` 服务，注册 6 个模型可见工具
 * （octop_status / octop_experts / octop_chat / octop_threads / octop_history /
 * octop_approve）。专家调用走 Octop 的 Agent MCP 网关，线程/历史走 REST；
 * 两者共用一个自动续期的 JWT。
 *
 * 为什么不用 defineTool / schemastery：端侧只能装纯 JS，第三方插件的模块解析
 * 到不了 DSH 核心包的 node_modules。这里零依赖，configuration 用普通对象在
 * apply 里校验，工具定义直接产出 registry 认的 ToolDefinition 形状。
 *
 * 配置（cordis.yml 里该插件行的 config）：
 *   baseUrl         Octop 地址，默认 http://127.0.0.1:8088
 *   username        Octop 账号（必填）
 *   password        Octop 密码（必填）
 *   defaultExpert   默认专家名或 id（可省）
 *   timeoutMs       普通请求超时，默认 60000
 *   chatTimeoutMs   专家对话/审批续跑超时，默认 900000（15 分钟）
 */

import { OctopClient } from './client.js'
import { OctopMcp } from './mcp.js'
import { createToolDefinitions } from './tools.js'

/** 插件名（cordis 诊断用）。 */
export const name = 'octop'

/** 依赖的工具注册表。 */
export const inject = ['tools']

/** 默认配置。 */
const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:8088',
  username: '',
  password: '',
  defaultExpert: '',
  timeoutMs: 60_000,
  chatTimeoutMs: 900_000,
}

/**
 * 把用户 config 收敛成已知字段；类型不对就回落到默认值，不让一个笔误把插件点不着。
 * @param {unknown} raw
 */
function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  /** @type {Record<string, unknown>} */
  const config = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    const value = source[key]
    if (value === undefined || value === null) continue
    if (key === 'timeoutMs' || key === 'chatTimeoutMs') {
      const numeric = Number(value)
      if (Number.isFinite(numeric) && numeric > 0) config[key] = numeric
      continue
    }
    if (typeof value === 'string') config[key] = value
  }
  config.baseUrl = String(config.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, '')
  config.username = String(config.username || '').trim()
  config.password = String(config.password || '')
  return config
}

/**
 * 挂载插件：建客户端 + MCP 桥，注册工具。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const client = new OctopClient(config)
  const mcp = new OctopMcp(client, config)
  const definitions = createToolDefinitions({ client, mcp, config })
  for (const definition of definitions) ctx.tools.register(definition)
}
