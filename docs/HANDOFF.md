# 交接状态（新会话先读这一份，不要重放历史）

## 已完成并真机验证（2026-11-20）
- 6 个模型工具：octop_status / experts / chat / threads / history / approve
- 侧边栏 🐙 Octop 面板：专家 → 线程 → 消息、发送、审批按钮、新对话
- 任意来源线程续聊：MCP（kind=expert）+ WS(/api/agents/{id}/chat/ws) 兜底
- 流式增量：桥 POST /chat-stream（SSE）+ 面板 ReadableStream 逐段渲染
- 端侧挂载：profile bundles 含 @seven/dsh-plugin-octop、@seven/dsh-plugin-agents-ui；
  桥 127.0.0.1:8791，token 写死在 bridge.js/client.js（octop-bridge-7f3a9c）
- 配置：profile cordis.patch.yml 的 `- id: octop` 块（baseUrl/username/password 明文）
- 系统返回键逐层后退（包装 window.__DSHM_BACK__.consume，标记 __octopWrapped）

## 本轮新增（代码完成，**尚未重启验证**）
- `lib/backends.js`：dsh 源真实实现（不再是占位）
- `lib/bridge.js`：路由改成 `/api/<源>/experts|threads|history|status|chat|chat-stream|approve`，
  旧路径继续可用（默认 octop）；`/sources` 列源
- `packages/agents-ui/lib/client.js`：源切换条变可点；所有请求走 `/api/<源>/…`；
  旧桥（没有 /api 路由）自动回落老路径；dsh 源隐藏审批 UI；删掉 typert remote 遗留代码
- `lib/remote.js` 已删（无任何 import）
- 上面这些**只有在 DSHM 重启后才会生效**（profile 的 patchReload: startup）

## 关键契约（Octop，实测）
- MCP 网关只开放 kind=expert，expert_id 用 agent_id（如 TEGCKN），REST 路由也用 agent_id
- 成功返回 {status, expert_id, thread_id, response, usage}
- 非 MCP 线程续聊报 "only MCP-created threads..." → 走 WS
- Octop 无 CORS，浏览器不能直连；安装器不读自定义 npm registry；不认自部署 git URL
- 安装器从 codeload.github.com 拉 tarball（github.com 本机 TLS 被重置，镜像推不上去）

## dsh 源实现契约（@deepseek-ai/dsh-subagent，0.2.2-rc.5）
- 起子会话：`ctx.subagents.startActivation({ provider:'spawn'|'fork', label, prompt:[{type:'text',text}],
  parent, signal, delivery:'caller' })`；`parent` 必须是 `ctx.agents.get(id)` 返回的**同一个对象**
  （`startActivation` 校验对象身份，不是 id 相等）
- 返回 `{ childId, name, result, dispose }`；**`result` 只在 dispose/父会话 teardown 时才 resolve**，
  continuable 子会话不能 await 它拿第一轮回复 → 必须轮询子会话日志等 `turn/end`
- 续聊：`ctx.subagents.sendMessage(parent, childId, blocks, { signal })`；
  signal 只管投递，不管这一轮执行；超时用 `ctx.subagents.interrupt(childId, { kind:'user' })`
- 线程列表：`ctx.subagents.listDescendants(sessionId)`，条目有 `{id,parentId,mode,label,createdAt}`，
  只挑 `mode==='continuable' && label==='DSH 助手' && parentId===会话`
- 标题：`ctx.sessionQuery.readTitleSnapshots([ids])`（批量，一次读多条）
- 历史：`ctx.sessionQuery.observeSession(id, { projectionMode:'none' })` → `header/events/cursor`，
  用完 `observation[Symbol.dispose]()`；只读 `header.origin === 'subagent'` 的会话
- 流式：`ctx.on('agent/assistant-stream', ({agent, frame}) => …)`，只要 `frame.type==='chunk'`
  且 `frame.chunk.type==='text-delta'`；事件是全局的，按子 agent id 过滤
- 父会话：面板传 `session`；没传就取 `ctx.agents.list()` 里最近创建的顶层会话
  （`session.header.origin !== 'subagent'`）
- 零依赖：插件不 import DSH 核心包，只通过 ctx.get 拿服务

## 桥路由（新）
- `GET  /sources`、`GET /status`
- `GET  /api/<源>/experts|threads|history|status`
- `POST /api/<源>/chat|chat-stream|approve`
- 旧路径 `/experts /threads /history /chat /chat-stream /approve` 仍可用（默认 octop）
- dsh 额外参数：`session`（父会话 id）、`timeoutMs`（默认 900000）
- SSE 帧：`{chunk}`（增量）、`{done,threadId,status}`、`{error}`、octop 还有 `{approval}`

## 端侧壳约定（实测）
- `window.__DSHM_BACK__ = { consume, state }`：系统返回键由宿主调用 consume() 询问页面是否消费；
  面板把它包一层，有层级时自己退一层并返回 true。包装标记 __octopWrapped 防重复。
- 同批可用桥：__DSHM_BRIDGES__、__DSHM_BRIDGE_CONTRACT__、dshmBridge

## 重启后要验的（按顺序）
1. 面板能列出两个源，切到 DSH 不报错（没有活动会话时应提示「先打开一个对话」）
2. DSH 源发一条消息：流式出现回复；面板里能看到块（子会话进父 catalog，UI 里能看到子 agent）
3. 同一条 DSH 线程续聊第二句（上下文保留）
4. 切回 Octop：老的专家/线程/历史/流式/审批不回归
5. 新建第二条 DSH 对话，两条线程都出现在线程列表

## 下一步
1. acp 源（Agent Client Protocol，一次覆盖 Claude Code / Gemini CLI / 等）
2. 各 CLI 源（codex / opencode / pi），按实际使用逐个补
3. 清理：profile 里 typert 方案拷的 6 个依赖（cordis/cosmokit/dsh-typert-protocol/dsh-brand/
   @standard-schema/spec/zod）——**删前先确认没有别的插件从 profile 根解析它们**
4. GitHub 镜像待代理或 ssh://git@ssh.github.com:443

## 工作纪律
- 改 lib/* 后必须同步到 profiles/ondevice/node_modules/@seven/…，再重启 DSHM（patchReload: startup）
- 面板包（packages/agents-ui）同样要同步到 profile 的 @seven/dsh-plugin-agents-ui，刷新页面生效
- 每次改完 git commit + push（Forgejo token 在会话里给过，写在 commit 命令里）
