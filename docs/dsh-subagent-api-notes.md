# dsh-subagent 接入笔记（源码级 + 后续实测校正）

> 来源：2026-11-21 凌晨一个并行会话（会话 id `f06a0842…`，工作目录 `~/Documents/dsh-plugin-octop-dshsrc`）
> 留下的源码级调研笔记。仓库主体实现是本仓库的 `lib/backends.js`，这份只作 API 参考保留。
> 该并行会话已停用，原始目录已删。
>
> **实测校正（2026-11-21，本仓库验证）**
> 1. 第 2 节说「一轮跑完后子会话被摘掉、`activation.result` 自然结算时会 resolve」——正确；
>    但**不要**用 `await activation.result` 拿首轮回复：它要等到这一轮收尾（子 agent 空闲后
>    `watchLocalSettlement` 触发 `finishDisposal`）才 resolve，中间面板会一直等；本仓库改为
>    轮询 `turn/end`（400ms）。
> 2. 第 6 节说 `delivery:'caller'` 能保证「结算不注入父会话」——**首轮成立，续聊不成立**：
>    子会话每轮结束都被摘掉，第二轮走冷恢复 `restoreTarget`，它**不传 delivery**，默认回
>    `'parent'`，于是这一轮结算时会给父会话投一条 `subagent-settled` 通知并可能唤醒父模型。
>    本仓库在 `agent/inbox/inserted` 里按 `source.kind + senderSessionId` 摘掉（见 lib/backends.js）。
> 3. 第 4 节的「面板取当前主视图会话」已按其线索验证并落地：
>    `ctx.sessions.list.getSnapshot().byId` 里 `retainedBy.mainView > 0` 的那行就是主视图会话。

> 依据：端侧核心 `0.2.2-rc.5+dshm.1`
> `/data/storage/el2/base/haps/phone/files/dsh/cores/0.2.2-rc.5+dshm.1/node_modules/@deepseek-ai/`
> 主要读的是 `dsh-subagent/src/{index,types,manager,list-children,control-types,projection-types}.ts`、
> `dsh-tool-subagent/src/index.ts`、`dsh-agent/src/{index,runtime-types}.ts`、
> `dsh-session-query/src/{index,observation}.ts`、`dsh-session-title/src/types.ts`。
> **没有运行时验证**（按纪律不重启应用、不碰 profile）：下面是源码级结论 + 一次 esbuild 语法校验。

## 0. 结论先说

- 任务里写的 `ctx.subagent.start(...)` **不存在**。真实服务名是 `ctx.subagents`，服务类是
  `SubagentRuntime`（`dsh-subagent/src/index.ts:194`），起子 agent 的方法是
  `startActivation(spec)`（`index.ts:267`），**没有 `start()`**。
- 可行路线就是「continuable 子会话」：`provider: 'spawn'`（已注册时）或 `'fork'`，
  子会话是 durable Session，`threadId = activation.childId`，续聊用 `sendMessage(...)`。
- **硬约束：必须传一个「精确存活的父 Agent 对象」**（`agents.get(id)` 返回的同一个对象，
  身份比较，不是 id 字符串）。这直接决定了面板场景的接入方式（见第 4 节）。
- 面板里最小可用路径：客户端把「当前主视图会话 id」传给桥 → host 用
  `ctx.get('agents').get(sessionId)` 拿到父 Agent → `startActivation`。
  拿不到会话时只能退回「最近创建的活顶层会话」，多会话同时活着时会挂错父。

## 1. 服务与起子会话

```ts
// ctx.subagents : SubagentRuntime
async startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation>
```

`SubagentActivationSpec`（`types.ts:29-46`，等于 `SubagentStartRequest` 去掉 `label/signal` 再加几个字段）：

| 字段 | 必填 | 语义 |
| --- | --- | --- |
| `provider` | 是 | 已注册的 provider 名。base 里注册了 `spawn`（`dsh-subagent-spawn-in-process`）和 `fork`（`-fork-in-process`）。用 `subagents.getProvider(name)` 探测；**没有列举 provider 的 API**，只能试名字。 |
| `label` | 是 | 写进父会话 catalog 的创建标签（`subagent/catalog` 事件），也是冷恢复后 catalog 行的 `label`。本实现固定 `'DSH 助手'` 用来筛面板线程。 |
| `prompt` | 是 | `ContentBlock[]`，例如 `[{ type: 'text', text }]`。 |
| `parent` | 是 | **精确存活的 Agent 对象**。校验在 `index.ts:275`：`this.ctx.get('agents')?.get(spec.parent.id) !== spec.parent → UNAUTHORIZED`。必须用 `ctx.get('agents').get(id)` 拿到的那个对象，不能自己造、不能拿旧引用。 |
| `signal` | 是 | 发布前取消会回滚（清理半成品后 reject）；发布后取消会中止这一轮。 |
| `delivery` | 是 | `'parent'` = 结果回传给父会话的模型（会唤醒父 agent）；`'caller'` = 只把结果返回给调用方，**不通知父模型**。面板场景用 `'caller'`。 |
| `name` | 否 | 父的子级唯一名（1–32 位小写字母/数字/连字符，首字母，不能叫 `lead`）。省略则自动 `agent-N`。`delivery:'caller'` 的外部 backend 不接受 name（本地 backend 可以）。 |
| `childId` | 否 | 预留的 durable 子会话 id（仅本地 backend）。不用传，自动 randomUUID。 |
| `agentPreset` | 否 | 需要 provider 的 `agentPreset` 能力且 `inheritsParentContext=false`；spawn 支持。 |
| `agentOptions` | 否 | `{provider, model, reasoningEffort, maxTokens}`，需 provider 的 `agentOptions` 能力；spawn 支持，会合并在父路由之上。 |
| `maxDepth` | 否 | 绝对委派深度上限，需 `depthLimit` 能力；**不传就不校验上限**（子深度 = 父深度+1 仍会记录）。 |
| `outputSchema` | 否 | 要求子 agent 以结构化结果收尾，需 `outputSchema` 能力。 |
| `cwd` | 否 | 子 agent 初始目录；省略继承父的当前目录（由 workingDirectory 解析）。 |

返回值 `SubagentActivation`（`types.ts:49-66`）：

```ts
{
  childId: SessionId,          // ↔ 面板的 threadId
  name: string,                // 'lead' / 'a/b' / 未命名时是 childId
  messageId?: MessageId,       // 本地 backend 必有（首条 prompt 被 inbox 接受）
  result: Promise<SubagentResult>,
  dispose(): Promise<void>,    // 只释放这一次 activation
}
```

`SubagentResult`（`types.ts:260-286`）：

```ts
{
  output: ContentBlock[],      // 子 agent 最后一条非空 assistant 消息（或被累积文本）
  structured?: unknown,        // 请求了 outputSchema 且满足时才有
  diagnostic?: string,         // 非 completed 时的失败说明（已脱敏，≤4096B）
  stopReason: 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal' | ...（merge-extensible）
}
```

## 2. result 与子会话生命周期（关键，容易踩）

- 本地 activation 在 `accept()` 后由 `watchLocalSettlement` 观察：子 agent `whenIdle()` → 无待处理
  inbox → `finishDisposal(activation, false)` 捕获 `result` 并 **`handle.dispose()`**。
- 也就是说：**一轮跑完后子会话就被从内存里摘掉（并 flush 到 persistence）**，
  `activation.result` 在自然结束时 **会 resolve**（不需要等 app 退出），但同一时刻子 agent 已经
  不是 resident 了。
- 因此第二轮开始走「冷恢复」：`sendMessage` → `deliverToMember` → `restoreTarget`：
  - `sessionQuery.observeSession(childId)` 读 durable 日志（需要 `sessionQuery` 服务 + session
    persistence，`manager.ts:1334-1356`）；
  - `foldSubagentDescriptor` 必须得到 `mode:'continuable'`（spawn/fork 创建时写了
    `subagent/descriptor`，`manager.ts:836`）；
  - 用持久化 header 的 `parentSession` 链 + 父会话 catalog 里必须有这个孩子
    （`resolveCreationAncestry`，`manager.ts:585-619`；缺 catalog 行直接 `UNAUTHORIZED`）；
  - 恢复后以 `delivery:'steer'` 投递，idle driver 会直接起一轮（`runtime-types.ts:254-261`）。
- 结论：**「关掉面板/重开 app 后还能续聊」是成立的**，前提是 persistence + sessionQuery 都在
  （base bundle 里有 `session-persistence-jsonl`、`session-query-sqlite`）。
  它们缺失时：`startActivation` 仍可能成功（`delivery:'caller'` 允许 persistence 缺失），
  但续聊一定失败（`NOT_RESUMABLE` / `CONTINUATION_UNAVAILABLE`）。

## 3. 续聊：sendMessage

```ts
// ctx.subagents
async sendMessage(
  sender: Agent,                 // 必须是「精确存活的树根」或「resident 的 continuable 成员」
  targetId: SessionId,           // 目标子会话 id（不能等于 sender.id）
  content: ContentBlock[],       // [{type:'text',text}]
  options: { signal: AbortSignal },
): Promise<MessageId>            // inbox 接受的消息 id，不代表跑完
```

- 内部：`rootOf(sender)` → `deliverToMember(root, targetId, …, {delivery:'steer'})`；
  目标不在 resident 里就冷恢复（见上）；目标属于别的 subagent tree → `UNAUTHORIZED`。
- 只返回「被接受」，**不返回结果**。要拿这一轮回复，只有两条路：
  1. 订阅生命周期 `subagent/end`（`{runId, id, stopReason, lastAssistantMessage}`，
     `types.ts:115-124`），事件是 scoped dispatch，根级插件 ctx 能收到；
  2. 轮询子会话日志（本实现用这条，确定性更好）：记 `baseline = observeSession(childId).cursor`，
     每 ~500ms 读一次，找 seq>baseline 的 `turn/end`（`data.reason.kind`）和最后一条
     `assistant/message`（`data.message.content`）。
- 不要在 sendMessage 后 `await agents.get(childId).whenIdle()` 之类地依赖 resident 对象：
  它随时可能被 teardown。

## 4. 面板场景：父 Agent 从哪来（最重要的一条）

- 插件 ctx 是 host 根部上下文，**没有「当前会话」这种概念**；`ctx.get('agents').currentInitiator()`
  只在某个 agent 的调用链里（tool 执行等）有值，HTTP 桥的请求里是 `undefined`。
- 所以桥必须自己拿到「用户正在看的会话」：
  - 客户端能拿到：client 侧 `ctx.get('sessions').list.getSnapshot().byId[*].retainedBy.mainView > 0`
    那一行就是主视图会话（`dsh-client-ui-workspace/src/client/navigation.ts:530` 用
    `source:'mainView'` retain；切 main 面板不会释放 `mainReference`，`clearMain()` 才释放）。
    面板是 `main` slot 的一个 keyed entry（`dsh-client-ui-layout/src/client/index.ts:197`），
    所以面板打开时主视图会话**通常仍被 retain**。
  - host 侧：`ctx.get('agents').get(sessionId)` → 精确活的 Agent。
- 兜底（面板没给 session）：`ctx.get('agents').list()` 里筛 `session.header.origin !== 'subagent'`，
  取 `createdAt` 最大的那个。**只在「有且只有一个活动会话」时才等价**；多会话会挂错父，
  而子会话又是按父会话 catalog 列线程的，挂错父会导致「线程列表里看不到刚聊的那条」。
- 还有两个必须注意的派生约束：
  1. **深度**：子深度 = 父深度 + 1。若父会话本身是别人的子 agent（`delegationDepth>=1`），
     且 `maxDepth` 配置是 1，起子会失败（`UNSUPPORTED_CAPABILITY`/depth 错误）。面板应提示
     「回到顶层会话再用」。
  2. **父会话必须是活的**：`agents.get(id)` 拿不到（会话已关闭/被回收）就 `UNAUTHORIZED`，
     救不回来（除非先 host 侧 resume 该会话，成本高且需要 agentOptions/preset，不建议在桥里做）。
     面板侧的兜底是：记住最后一次 mainView 会话 id（localStorage），并在报错里明确提示
     「先在对话页打开它再回来」。

## 5. 线程列表与历史

- 线程 = 父会话 catalog 里的 continuable 子会话：
  ```ts
  // ctx.subagents.listDescendants(rootSessionId, signal?)
  // → (SubagentCatalogRow | diagnostic)[]
  // child 行: { kind:'child', id, mode:'one-shot'|'continuable'|'external', label?, name?, createdAt,
  //             parentId, depth, path?, activity:'running'|'inactive', hasChildren }
  ```
  只挑 `mode==='continuable' && label===<我们的标签>`，**必须再按 `row.parentId===父会话id` 过滤**
  （递归结果里还有孙辈）。
- 标题：`ctx.get('sessionQuery').readTitle(childId)` 或批量 `readTitleSnapshots([ids])`
  （`dsh-session-query/src/index.ts:232-263`，批量版返回 per-id `{status:'fulfilled', value:{title, updatedAt}}`）。
  没有标题事件时退回固定文案。
- 历史：`sessionQuery.observeSession(childId, { projectionMode:'none' })` → `events`，
  投影 `user/message`（`data.content`）与 `assistant/message`（`data.message.content`），
  `contentText` 只取 `type:'text'` 块。建议顺手校验 `header.origin === 'subagent'`，别让桥
  变成能读任意会话的后门。`tool/call`/`tool/result` 不进聊天视图（要显示就自己再投影一层）。
- 读完之后要释放观察租约：`observation[Symbol.dispose]()`（`SessionObservation extends Disposable`）。

## 6. delivery:'caller' 的副作用（选它要认账）

- 好处：子 agent 这一轮的结算**不会**以 `send_message` 形式注入父会话模型，不会打乱父对话。
- 代价/注意：
  - 子会话**仍然会进父会话 catalog**（`establishCatalogChild` 对本地子会话无条件调用），
    所以父会话的 `list_agents` 会看到它，名字是 `agent-N`，label 是我们的标签。
    想区分只能靠 label/name（本实现靠 label）。
  - 子 agent 的工具审批不会走 octop 面板（面板没有审批通道）。若子 agent 触发需要审批的工具，
    这一轮会一直等到超时被 abort。要么接受这个限制，要么给子会话套一个更宽松的 permission
    preset / 在桥里加审批透传（后者需要订阅子会话的审批请求，工作量另算）。
  - 子 agent 用父的 composition/preset（不传 `agentPreset` 时 `applyChildComposition` 继承父），
    工具集、cwd、权限跟父一致。

## 7. 本轮实现（`lib/`）怎么对应

| 文件 | 做了什么 |
| --- | --- |
| `lib/backends.js` | `createBackends({client, mcp, ctx})`；octop 的 listThreads/history 在这里直接投影成面板形状（`projectThread/projectHistory` 从 bridge 搬过来，避免桥里再分源处理）；dsh 源：`status()→available:true`、`listAgents()→[{id:'dsh',name:'DSH 助手'}]`、`listThreads`（父 catalog 过滤 label + 批量标题）、`history`（子会话日志投影）、`send`（新线程 `startActivation`，老线程 `sendMessage`+轮询 `turn/end`）。 |
| `lib/bridge.js` | `startBridge({client,mcp,ctx})`；所有数据路由认 `source`（GET query / POST body，默认 octop，老路径行为不变）与 `session`；`/chat`、`/chat-stream` 加 dsh 分支（dsh 目前一次性回整段回复帧，不做 token 流）；`/approve` 只给 octop；`req/res` 挂空 error 监听防断连带走进程。 |
| `lib/index.js` | `startBridge({ client, mcp, ctx })`。 |
| `agents-ui/lib/client.js` | 源切换条可点击（`available===false` 置灰）、所有请求带 `source`、带 `session`（client 侧 `sessions.list` 的 mainView 行 + localStorage 兜底）、dsh 新对话从 `done` 帧接管 `threadId`（否则每条消息都新开线程）、dsh 不显示审批块、错误页加「返回」。 |

## 8. 最小可用路径（如果要在面板里跑通 dsh 源）

1. 面板：加源选择（`/sources` 已有），请求带 `source`。
2. 面板：把当前主视图会话 id 带上（`sessions.list` 里 `retainedBy.mainView>0` 的行；再存一份
   到 localStorage 兜底）。
3. 桥：`createBackends({client,mcp,ctx})`，dsh 分支把 `session` 传给 backend。
4. backend：`resolveParent = ctx.get('agents').get(session)`；`startActivation({provider:'spawn',
   label, prompt:[{type:'text',text}], parent, signal, delivery:'caller'})`；`threadId=childId`。
5. 续聊：`sendMessage(parent, threadId, [{type:'text',text}], {signal})` + 轮询
   `turn/end`/`assistant/message`（或用 `subagent/end` 事件）。
6. 列表/历史：`listDescendants(父会话id)` 过滤 `mode==='continuable' && label===…&& parentId===父`；
   `observeSession(childId)` 投影消息。
7. 失败提示要具体：没有活会话 / 会话不在运行 / provider 未注册 / 深度超限 / 冷恢复失败
   （`NOT_RESUMABLE`、`CONTINUATION_UNAVAILABLE`）。

## 9. 未验证点（诚实清单）

- 没有重启应用，所以：`ctx.get('subagents')` 在插件 ctx 上可取、`startActivation` 从 HTTP 桥的
  异步链里能成功、`sendMessage` 冷恢复路径、`listDescendants` 对持久化父会话能读到 catalog ——
  这些都只有源码依据，没有真机跑通证据。
- 面板是 `main` slot 的 keyed entry，我推断切到面板时 `mainReference`（mainView retain）不释放，
  所以 `sessions.list` 里仍能找到主视图会话；如果实际会被释放，就必须依赖 localStorage 记住的
  会话 id（本实现已加），或改成在切面板前先记录。
- 「子 agent 工具审批挂死到超时」只是从架构推断（面板没有审批通道），未实测。
