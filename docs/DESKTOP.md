# 在桌面版 DSH 上安装本插件

适用：DSH NEXT / DSH Desktop（核心 0.2.2-rc.5 或兼容版本）。
插件是纯 JS、零运行时依赖，手机和桌面共用同一份代码。

## 一、准备两个包

本仓库产出两个 npm 包（必须都装，缺一个就没有面板或没有工具）：

| 包 | 作用 | 打包命令 |
|---|---|---|
| `@seven/dsh-plugin-octop` | host：6 个 octop_* 工具 + 本机 HTTP 桥（127.0.0.1:8791） | `python3 scripts/pack-tgz.py --dir . --out dist/dsh-plugin-octop-0.1.0.tgz` |
| `@seven/dsh-plugin-agents-ui` | client：侧边栏面板（源/专家/线程/消息/审批） | `python3 scripts/pack-tgz.py --dir packages/agents-ui --out dist/dsh-plugin-agents-ui-0.1.0.tgz` |

把两个 `.tgz` 拷到电脑。

## 二、安装

设置 → 插件 → **安装第三方插件**（支持 npm 包 / Git 仓库 / 本地目录）

1. 先装 host 包：选择 `dsh-plugin-octop-0.1.0.tgz`
2. 再装面板包：选择 `dsh-plugin-agents-ui-0.1.0.tgz`
3. 重启 DSH

如果安装对话框只认目录不认 tgz：解压 tgz，选择解压出来的 `package/` 目录（里面有 package.json）也可以。

## 三、配置 Octop 连接（必须）

插件默认 baseUrl 是 `http://127.0.0.1:8088`、账号为空，需要在 profile 的
`cordis.patch.yml` 里覆盖（`<dsh-home>/profiles/<profile>/cordis.patch.yml`）：

```yaml
- id: octop
  config:
    baseUrl: http://192.168.3.80:8088
    username: seven
    password: 你的密码
    defaultExpert: ''
    timeoutMs: 60000
    chatTimeoutMs: 900000
```

> 这行会把 bundle 里插入的 `- id: octop` 行整块替换（同名行后者覆盖前者）。
> 改完重启 DSH。

## 四、验证

- 工具：问 agent「octop 状态」，应能调用 octop_status
- 面板：左侧栏出现 🐙/网络图标，点开能看到专家列表
- 若面板空白但工具正常：面板的客户端包没装上（`dsh.client` 没被加载），检查第二步

## 五、已知差异

- **ACP 源**：桌面端理论上可以 spawn 外部 ACP agent（Linux/macOS/Windows 没有端侧那层拦截），
  但 `lib/acp.js` 还没有真机验证过，装好 CLI 后可以试
- **DSH 源**：面板里的 DSH 源在桌面端同样可用（`ctx.subagents` 是同构的）
- 桥只绑 127.0.0.1，不对外暴露；token 写死在 `lib/bridge.js` / 面板 `client.js` 里
