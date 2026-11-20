# dsh-plugin-octop

在 DSH 里操作 [Octop](https://github.com/TencentCloud/Octop)（腾讯开源的自托管多 Agent AI 助手）。

用法：DSH 里直接说「让 Octop 的 XX 专家帮我做 YY」，模型会调用下面的工具；专家干活、
你续聊、审批工具动作都在同一个会话里完成。

## 状态

| 部分 | 状态 |
|---|---|
| Octop 侧接口契约 | ✅ **已实测通过**（Octop `1.0.3b7` @ `http://192.168.3.80:8088`，2026-11-20） |
| 插件代码（6 个工具 + 自动登录续期） | ✅ **已装机验证**（DSHM 端侧，bundle 方式挂载，6 个工具全部跑通） |
| 安装通道 | 端侧安装器只认 npm 包名 / github.com；Forgejo 的 npm registry 包已发布，但安装器不读自定义 registry（3 处 `installer.json` 实测无效），当前为本地 bundle 挂载 |
| 多源骨架 | Octop（已验证）+ DSH（本进程 subagent，代码完成，**待重启验证**）；桥按 `/api/<源>/…` 分源 |
| GitHub 镜像 | ⚠️ Forgejo → GitHub 推送被 TLS 重置（跨境网络），待代理/SSH:443 解决 |

### 真机验证记录（2026-11-20）

| 工具 | 结果 |
|---|---|
| `octop_status` | ✅ 连通、`1.0.3b7`、登录 seven(admin)、MCP 可用、6 个专家 |
| `octop_experts` | ✅ 只列 `kind=expert`（managed/team 被排除） |
| `octop_chat` | ✅ 新开线程 + 返回 `thread_id` + 回复 |
| `octop_chat`（带 thread_id） | ✅ 续聊，专家记住了上一轮问题 |
| `octop_threads` | ✅ 3 条线程，标题/时间正确 |
| `octop_history` | ✅ 消息角色/正文正确，`thinking` 块被过滤 |
| `octop_approve` | ⚠️ 只验了「无待审批线程」分支：Octop 返回 `status=completed` + 空 response，插件不报错；真实审批场景尚未触发 |

已知小瑕疵（下次重启顺手修）：无待审批线程上调用 `octop_approve` 时，空 `response` 会让 render 回显原始 JSON。

### 实测到的真实契约（和文档有出入，代码已按实测改）

| 项 | 实测结果 |
|---|---|
| health | `{ok, started_at, db, users_loaded, agents_running, channels:[…]}`，无 version 字段 |
| 登录 | `{access_token, expires_in, token_type, user}`，**没有顶层 `role`**（role 在 JWT 载荷里） |
| 专家列表 | `GET /api/agents` 返回数组，每项同时有 `id`（数字）和 `agent_id`（如 `TEGCKN`） |
| REST 路由 | `/api/agents/{agent_id}/threads…` 用 **agent_id 字符串**；传数字 id 报 `404 AGENT_NOT_FOUND` |
| MCP 握手 | `2025-06-18` 成功，`serverInfo = octop-agent-mcp-gateway 1.0.3b7` |
| MCP 专家范围 | 网关只开放 `kind=expert`；`kind=managed`（coder）和 `kind=team`（开发团队）**不在网关里**，调用报 `expert 'X' not found` |
| `call_octop_expert` | 入参 `{expert_id:string, message:string, thread_id?:string}`，必填前两个 |
| 成功返回 | `{status:"completed", expert_id, thread_id:"thr_…", response, usage}` —— 回复字段是 **`response`** |
| `resume_octop_expert` | 入参 `{expert_id, thread_id, decisions:[{type:"approve"\|"edit"\|"reject"\|"respond", message?, edited_action?}]}` |
| 线程列表 | `[{thread_id, title, channel_type, last_active(epoch 秒), turn_active, awaiting_user, …}]` |
| 线程历史 | `{messages:[{role, content:[{type:"text",text} \| {type:"thinking",thinking}]}], turn_active, hitl_pending, history_status}` |
| 错误形态 | MCP 工具失败走 `isError:true` + `structuredContent.error`，HTTP 仍 200 |

### 还没验证的

- **审批的返回体形状**：实测那位专家策略自动放行（直接写文件成功），没触发 `approval_required`；
  `decisions` 的 schema 已确认，`octop_approve` 的 MCP + REST 两条路都写好了，等真实审批场景验。
- 长任务（超过 `chatTimeoutMs` 15 分钟）与流式增量输出。

## 目录

```
dsh-plugin-octop/
├── lib/
│   ├── index.js    # cordis 插件入口：收敛配置、注册工具、起本机 HTTP 桥
│   ├── client.js   # REST 客户端：登录换 JWT、令牌缓存/提前续期、401 重登、超时
│   ├── mcp.js      # Octop Agent MCP 网关最小客户端（initialize / tools/list / tools/call）
│   ├── tools.js    # 6 个模型可见工具的定义与投影
│   ├── backends.js # 多源注册表：octop + dsh（本进程 subagent）+ acp
│   ├── bridge.js   # 127.0.0.1:8791 的 HTTP/SSE 桥，路由 /api/<源>/…
│   ├── acp.js      # ACP 客户端（NDJSON JSON-RPC）：探测/连接外部 ACP agent
│   └── ws.js       # Octop 对话 WebSocket 通道（非 MCP 线程续聊）
├── scripts/
│   └── octop-m0.py # M0 冒烟：不装插件也能验证 Octop 网络/账号/接口形状
├── packages/agents-ui/    # 侧边栏面板（客户端插件：源切换 / 专家 / 线程 / 消息 / 流式）
└── examples/
    └── cordis-entry.yml
```

## 多源（backend 接口）

每个源实现 5 个方法：`status / listAgents / listThreads / history / send`；桥和面板只认接口。

| 源 | 形态 | 线程 = | 状态 |
|---|---|---|---|
| `octop` | 远端 Octop 专家（REST + MCP 网关） | Octop thread_id | ✅ 真机验证 |
| `dsh` | 本进程 subagent（`ctx.subagents`，provider=spawn） | continuable 子会话的 Session id | 代码完成，待重启验证 |
| `acp` | 外部 ACP agent（Claude Code / Gemini CLI / Qwen Code） | ACP sessionId | 骨架完成，未真机验证（端侧无二进制 + spawn 受限） |
| `cli` | 各 CLI（codex / opencode / pi…） | — | 未开始 |

dsh 源要点：

- 父会话 = 面板传的 `session`，没传就取**最近创建的活会话**（`ctx.agents.list()` 里 `origin !== 'subagent'` 的那个）。
- 新对话 = `ctx.subagents.startActivation({ provider:'spawn', delivery:'caller', label:'DSH 助手' })`，
  返回的 `childId` 就是 threadId；子会话进父会话的 subagent catalog，但不打扰父会话的模型。
- 续聊 = `ctx.subagents.sendMessage(parent, threadId, …)`；子会话被回收时 manager 自动冷恢复。
- 流式 = 订阅 `agent/assistant-stream` 的 `chunk`（`text-delta`），按子 agent id 过滤后透传 SSE。
- 线程列表 = `ctx.subagents.listDescendants(session)` 里 `mode=continuable && label='DSH 助手'` 的条目；
  标题 = `ctx.sessionQuery.readTitleSnapshots([...])`；历史 = `observeSession(threadId).events` 投影。

桥路由：`GET /api/<源>/experts|threads|history|status`、`POST /api/<源>/chat|chat-stream|approve`；
旧路径 `/experts`、`/chat-stream` 等继续可用（默认 octop）。`GET /sources` 列出所有源。

## 工具

| 工具 | 作用 |
|---|---|
| `octop_status` | 自检：baseUrl 可达、账号能登录、Agent MCP 是否可用、有哪些专家 |
| `octop_experts` | 列**可调用**专家（`kind=expert`；agent_id / 名称 / 描述 / 模型 / 是否运行中） |
| `octop_chat` | 让某专家跑一轮对话，返回回复 + `thread_id`；带 `thread_id` 即续聊 |
| `octop_threads` | 列某专家的对话线程 |
| `octop_history` | 读线程历史，报告 `turn_active` / `hitl_pending` |
| `octop_approve` | 专家等审批时提交 `approve` / `reject` / `respond` 并续跑 |

`expert` 参数吃专家名或 `agent_id`（如 `TEGCKN`）；`octop_experts` 输出的就是可调用的那批，
`kind=managed` / `kind=team` 的 agent 会被明确拒掉并说明原因。

## 配置

`examples/cordis-entry.yml`：

```yaml
- insert:
    - name: dsh-plugin-octop
      config:
        baseUrl: http://192.168.1.10:8088
        username: dsh
        password: '********'
        defaultExpert: 我的助手   # 可省：只配一个专家时可省略 expert 参数
        timeoutMs: 60000          # 普通请求，默认 60s
        chatTimeoutMs: 900000     # 专家对话/审批续跑，默认 15min
```

## M0 冒烟（先做这个）

在**这台设备上**跑（用的是宿主 Python，能直连局域网）：

```bash
python3 scripts/octop-m0.py --config ~/.octop-m0.json
# 或者：
python3 scripts/octop-m0.py --base http://192.168.1.10:8088 --user admin --pass 'xxx'
```

`~/.octop-m0.json`：

```json
{ "base": "http://192.168.1.10:8088", "user": "admin", "pass": "xxx" }
```

它会依次验证 health → 登录 → 专家列表 → MCP 握手 → `tools/list`，并把三个工具的
**真实参数名**打印出来；加 `--prompt '你好'` 还会真跑一轮专家对话，再读线程历史。

这一步的意义：插件里对 MCP 参数名做了自适应映射（`expert_id|agent_id|id`、
`message|prompt|content`、`thread_id|conversation_id`），但**只有看到真实 inputSchema
才能确认没有漏项**；顺便验证网络、账号、令牌 24h 机制。

## 装进 DSH 的两种路径

1. **正式（推荐，待仓库）**：推到 GitHub 或用 npm 发布，然后
   `pnpm add github.com/<owner>/<repo>`（或 `pnpm add dsh-plugin-octop`），
   装完**重启 DSHM 应用**才挂载。设置 → 插件 页也能装。
2. **临时手挂（未验证）**：把包放进 `$DSH_HOME/profiles/ondevice/node_modules/`，
   在 `$DSH_HOME/cordis.patch.yml` 里 insert 一行插件条目，重启应用。
   核心 loader 的裸模块解析根不一定包含 profile 目录，所以这条路可能报
   `Cannot find package`；失败就老实走第 1 条。

## 设计取舍

- **专家调用走 Agent MCP 而不是自己接 WebSocket**：`/api/mcp/agents` 是官方为外部程序
  提供的入口，审批语义（`approval_required` + `resume_octop_expert`）白送；不用自己处理
  WS 重连、`subscribe`、帧格式。
- **线程/历史走 REST**：MCP 不提线程列表和历史，REST 有完整端点。
- **不用 `defineTool` / `schemastery`**：端侧只能装纯 JS，第三方插件的模块解析到不了
  DSH 核心包的 `node_modules`；零依赖 = 少一类装不上的原因。工具定义直接产出 registry
  认的 `ToolDefinition` 形状（`parameters` / `output.schema` 用完整 JSON Schema）。
- **令牌不落盘**：只在内存里缓存，过期前 2 分钟自动重登，401 再重登一次。密码在插件
  配置里（profile 配置文件），建议给 DSH 单独开一个 Octop 账号，别用管理员密码。
- **未知字段一律兜底**：`thread_id`/`reply`/`status` 都做了多名候选提取，服务端字段名
  变了不会直接崩，最差退化成把整个返回体当文本。

## 已知不确定点 / 后续改进

1. 审批的返回体形状没实测（当前那位专家自动放行）；`octop_approve` 里 MCP 与 REST 两条路都已实现。
2. `hitl_pending` 的具体结构（插件目前直接把它 JSON 化展示）。
3. 长任务：`call_octop_expert` 同步等回复，超过 `chatTimeoutMs` 会超时；后续可改成
   「先返回 thread_id，再轮询 history」。
4. 流式输出：目前拿整段回复，没有逐字增量（DSH 侧要增量得走 WS，M2 再评估）。
5. `agent_id` 会在 Octop 重建专家时变化，插件每次都实时拉列表，不缓存跨进程的 id。

## 安全

- 跨公网务必 HTTPS（Bearer 令牌）。
- Octop 登录默认 5 次失败锁 15 分钟，插件不会重试登录，只会在 401 时重登一次。
- 插件只能操作当前账号有权限的资源；`octop_experts` 只看得到自己的 + 共享给你的专家。


## ACP 源（骨架）

- 核心的 `@deepseek-ai/dsh-acp` 是 **server**（把 DSH 暴露成 ACP agent），不是客户端；
  插件又解析不到核心 `node_modules` 里的 `@agentclientprotocol/sdk`，所以 `lib/acp.js`
  自己实现了 ACP 客户端需要的最小集：NDJSON 分帧 + JSON-RPC 2.0 + `initialize` /
  `session/new` / `session/prompt` / `session/update` / `session/request_permission`。
- 探测：在 `PATH` + `/system/bin`、`/usr/local/bin`、`/usr/bin` 里找
  `claude-code-acp`、`gemini`、`qwen`；一个都没有时源置灰并说明找过什么。
- 限制：端侧进程创建受限（HANDOFF E15），装了 CLI 也未必能 spawn；错误会原样回给面板。
  ACP 没有统一的历史读取接口，线程/消息只活在内存里，重启即丢。
