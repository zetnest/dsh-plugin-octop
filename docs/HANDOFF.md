# 交接状态（新会话先读这一份，不要重放历史）

## 已完成并真机验证
- 6 个模型工具：octop_status / experts / chat / threads / history / approve
- 侧边栏 🐙 Octop 面板：专家 → 线程 → 消息、发送、审批按钮、新对话
- 任意来源线程续聊：MCP（kind=expert）+ WS(/api/agents/{id}/chat/ws) 兜底
- 流式增量：桥 POST /chat-stream（SSE）+ 面板 ReadableStream 逐段渲染
- 端侧挂载：profile bundles 含 @seven/dsh-plugin-octop、@seven/dsh-plugin-agents-ui；
  桥 127.0.0.1:8791，token 写死在 bridge.js/client.js（octop-bridge-7f3a9c）
- 配置：profile cordis.patch.yml 的 `- id: octop` 块（baseUrl/username/password 明文）

## 关键契约（实测）
- MCP 网关只开放 kind=expert，expert_id 用 agent_id（如 TEGCKN），REST 路由也用 agent_id
- 成功返回 {status, expert_id, thread_id, response, usage}
- 非 MCP 线程续聊报 "only MCP-created threads..." → 走 WS
- Octop 无 CORS，浏览器不能直连；安装器不读自定义 npm registry；不认自部署 git URL
- 安装器从 codeload.github.com 拉 tarball（github.com 本机 TLS 被重置，镜像推不上去）

## 多源聚合设计（已定稿，按此实现）

backend 接口（每个源实现这 5 个方法，面板只认接口不认源）：
  status()                    -> {label, available, detail}
  listAgents()                -> [{id, name, description}]
  listThreads(agentId)        -> [{id, title, updatedAt, writable}]
  history(agentId, threadId)  -> [{role, text}]
  send(agentId, threadId, prompt, onChunk) -> {threadId, status, approval}

接入优先级（按成本排序）：
  1. dsh    —— 本进程 subagent（ctx.subagent / dsh-subagent），天然带工具，适配成本最低
  2. acp    —— Agent Client Protocol，一次覆盖 Claude Code / Gemini CLI 等一批（核心已有 dsh-acp）
  3. octop  —— 已完成，作为自托管平台样板
  4. cli    —— codex / opencode / pi 等，按实际使用逐个补

桥的路由改成带源前缀：/api/<source>/experts|threads|history|chat-stream
未指定源时默认 octop，保持旧路径兼容（面板先不改也能跑）。

## 下一步
1. SSE 透传 approval 帧（面板审批在流式模式可用）
2. 多源聚合：backend 接口 {listAgents,listThreads,history,send,status}；先 octop，再 codex/claude/opencode/pi；面板顶部源切换
3. 清理：删 lib/remote.js；清 profile 里 typert 方案拷的 6 个依赖（cordis/cosmokit/dsh-typert-protocol/dsh-brand/@standard-schema/spec/zod）
4. GitHub 镜像待代理或 ssh://git@ssh.github.com:443

## 工作纪律
- 改 lib/* 后必须同步到 profiles/ondevice/node_modules/@seven/…，再重启 DSHM
- 每次改完 git commit + push（Forgejo token 在会话里给过，写在 commit 命令里）
