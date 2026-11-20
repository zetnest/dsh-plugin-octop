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

## 本轮新增（已真机验证，2026-11-21 00:2x）
- `lib/backends.js`：dsh 源真实实现（不再是占位）
- `lib/bridge.js`：路由改成 `/api/<源>/experts|threads|history|status|chat|chat-stream|approve`，
  旧路径继续可用（默认 octop）；`/sources` 列源
- `packages/agents-ui/lib/client.js`：源切换条变可点；所有请求走 `/api/<源>/…`；
  旧桥（没有 /api 路由）自动回落老路径；dsh 源隐藏审批 UI；删掉 typert remote 遗留代码
- `lib/remote.js` 已删（无任何 import）
- 上面这些**只有在 DSHM 重启后才会生效**（profile 的 patchReload: startup）

### dsh 源实测结果（2026-11-21）
- `/status.startedAt` = 16:13:05Z 那次重启后，历史过滤生效：「你好」「Hello」各 2 行
- 新线程 1.7s 回「收到」；续聊 2.6s 回「继续」，同一 threadId，历史 4 行，`Agent … sent a message:` 前缀已剥
- 冷恢复续聊不再给父会话漏 `subagent-settled` 通知（a07a00e 的 inbox 拦截）

### 三个已踩过的坑（改 dsh 源必读）
1. **`activation.result` 只在 dispose/结算时 resolve**（不是第一轮结束），不能 await 它拿回复；
   而且 local 子会话每轮结束都会被 `watchLocalSettlement` 自动 close —— 一个 activation 只覆盖一轮。
2. **冷恢复丢 caller 语义**：`restoreTarget` 不传 `delivery`，默认 `parent`。于是每轮续聊结算都会
   往父会话 inbox 投一条 `subagent-settled` 通知（还可能唤醒父模型）。插件在
   `agent/inbox/inserted` 里按 `source.kind==='subagent-settled' && senderSessionId ∈ 面板子会话`
   直接 `inbox.remove`。若哪天漏出来，说明父模型已先取走消息，需要换 `agent/inbox/claimed` 兜底。
3. **Octop 令牌是懒登录的**：重启后 `/sources` 若只看 `client.token` 会把 Octop 误报成不可用，
   面板 chip 置灰且切不回来。已两头修：`status()` 里 ensureToken + 面板加载专家后重拉 `/sources`。

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
- 返回 `{ childId, name, result, dispose }`；local 子会话一轮结束就被 `watchLocalSettlement`
  自动 close，`result` 在这一轮收尾时 resolve——但 await 它等于「等整轮收拾完」，面板拿不到
  中间进度 → 本实现轮询子会话日志等 `turn/end`（400ms）
- 续聊：`ctx.subagents.sendMessage(parent, childId, blocks, { signal })`；
  signal 只管投递，不管这一轮执行；超时用 `ctx.subagents.interrupt(childId, { kind:'user' })`
- 线程列表：`ctx.subagents.listDescendants(sessionId)`，条目有 `{id,parentId,mode,label,createdAt}`，
  只挑 `mode==='continuable' && label==='DSH 助手' && parentId===会话`
- 标题：`ctx.sessionQuery.readTitleSnapshots([ids])`（批量，一次读多条）
- 历史：`ctx.sessionQuery.observeSession(id, { projectionMode:'none' })` → `header/events/cursor`，
  用完 `observation[Symbol.dispose]()`；只读 `header.origin === 'subagent'` 的会话
- 流式：`ctx.on('agent/assistant-stream', ({agent, frame}) => …)`，只要 `frame.type==='chunk'`
  且 `frame.chunk.type==='text-delta'`；事件是全局的，按子 agent id 过滤
- 父会话：面板传 `session`（client 侧 `ctx.sessions.list.getSnapshot().byId` 里
  `retainedBy.mainView > 0` 的那条，localStorage 兜底）；会话已不在运行时回落到
  `ctx.agents.list()` 里最近创建的顶层会话（`origin !== 'subagent'`）。
  续聊优先用 `threadParents` 里记住的创建者父会话，避免面板切了主视图就 UNAUTHORIZED。
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
1. 面板能列出两个源，切到 DSH 不报错（没有活动会话时应提示「先打开一个对话」）✅
2. DSH 源发一条消息：流式出现回复 ✅（API 层验证；面板气泡合并待肉眼确认）
3. 同一条 DSH 线程续聊第二句（上下文保留）✅
4. 切回 Octop：老的专家/线程/历史/流式/审批不回归（专家列表 ✅；流式/审批待肉眼确认）
5. 新建第二条 DSH 对话，两条线程都出现在线程列表 ✅

## 参考资料
- `docs/dsh-subagent-api-notes.md`：并行会话留下的源码级 API 笔记（含本仓库的实测校正），
  写 dsh 源前值得先扫一遍。

## 当前 git 状态
- `48a217a` 起：dsh 源 + 面板修复 + 通知拦截，Forgejo `main` 已同步
- 运行中的 host 若 `/status.startedAt` 早于提交时间，说明还没重启，见上面「工作纪律」

## 下一步
1. ~~acp 源~~（骨架已提交；端侧不可用，见下）
2. 用 tarball/path 走官方安装通道分发本插件（已验证 install/remove 可用）
3. VM 桥接调研（外部 agent 唯一可能的活路）
4. 清理 / GitHub 镜像

## 端侧限制（2026-11-21 实测，写死了很多路）

- **进程创建被宿主主动拦截**：官方 `@deepseek-ai/dsh-subagent-codex` 能装、能注册
  （`subagent_codex` 工具当场出现），但启动时 `spawn(process.execPath)` 被 DSHM 兜底拦掉：
  `dshm-host.log/node-output.log` 里是
  `execPath spawn 兜底：已拦截 spawn(process.execPath)（见 main.js 注释）`，工具报
  `subagent-codex: Product subagent failure (product: Codex; stage: initialize; category: unknown)`。
  `@openai/codex` 也只有 JS wrapper，没有 ohos-arm64 原生包。
  ⇒ **任何「宿主 spawn CLI」的 subagent provider（codex / claude-code / 我们手写的 ACP）
  在本机都跑不起来**；acp/cli 源保持置灰是正确状态。唯一活路是 VM 里跑 CLI + 宿主↔guest 桥接。
- **进程内安装通道可用，但端侧入口很窄**：`plugin_manager install_bundle` 走
  `dshm-profile-pnpm` 的端侧安装队列，pnpm 能从 npmjs 拉包（实测装了
  `@deepseek-ai/dsh-subagent-codex` 共 6 个包，含 `@openai/codex`，随后已卸载）。
  **但端侧安装器只认三种 spec**：npm 包名、GitHub 仓库/页面地址、`github:owner/repo`
  简写；核心虽然支持本地 `path`/`.tgz`（`install-spec.ts`），端侧入口会先拒：
  `无法识别的插件标识：…（支持 npm 包名；GitHub 仓库地址…；github: 简写）`。
  实测本地 tgz 和自建 Forgejo 的 `http://192.168.3.80:3007/...git` 都被拒。
  ⇒ 自建 registry 的插件目前只能「`scripts/sync-profile.py` 同步 + 重启」；
  要真装只有两条路：发到 npm（需要 npm token）或等 GitHub 可达。
- **脚本**：`scripts/pack-tgz.py`（打 npm 风格 tgz）、`scripts/sync-profile.py`
  （同步 lib + 面板到 profile，带哈希校验，`--check` 只校验）。

## ACP 源现状（`lib/acp.js`，2026-11-21）
- 核心 `@deepseek-ai/dsh-acp` 是 **ACP server**（DSH 当 agent），不是客户端；
  插件解析不到核心 `@agentclientprotocol/sdk`，所以自己写最小客户端：
  NDJSON 分帧 + JSON-RPC 2.0 + initialize / session-new / session-prompt /
  session-update / request-permission（默认自动选 allow_once，否则取消）。
- 按需 `await import('./acp.js')`：写坏了也只影响 acp 源，不会拖垮 octop/dsh。
- 探测命令：`claude-code-acp` / `gemini --experimental-acp` / `qwen --experimental-acp`，
  扫 PATH + /system/bin、/usr/local/bin、/usr/bin。
- 未验证项：真实 ACP agent 握手、流式 update、权限请求；端侧没有二进制，只能到「置灰 + 说明」为止。
- 线程与消息只在内存（ACP 无历史接口），重启即丢；上限 50 条。
2. 各 CLI 源（codex / opencode / pi），按实际使用逐个补
3. 清理：profile 里 typert 方案拷的 6 个依赖（cordis/cosmokit/dsh-typert-protocol/dsh-brand/
   @standard-schema/spec/zod）——**删前先确认没有别的插件从 profile 根解析它们**
4. GitHub 镜像待代理或 ssh://git@ssh.github.com:443

## 工作纪律
- 改 lib/* 后必须同步到 profiles/ondevice/node_modules/@seven/…，再重启 DSHM（patchReload: startup）
- 面板包（packages/agents-ui）同样要同步到 profile 的 @seven/dsh-plugin-agents-ui，刷新页面生效
- 每次改完 git commit + push（Forgejo token 在会话里给过，写在 commit 命令里）
