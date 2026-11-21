# 改名清单（dsh-plugin-octop → 新名字）

> 起因：项目名里带着 Octop 产品名，后续要改名；GitHub 镜像/发布暂缓到定名之后。
> 注意：**数据源 id `octop` 是 Octop 产品语义，不随插件改名**——桥路由 `/api/octop/...`、
> 面板里的源切换条、Octop 的工具名都保持不动。要改的只是「插件/包/面板」这层身份。

## 一、两个 npm 包

| 现在 | 改成 | 影响 |
|---|---|---|
| `@seven/dsh-plugin-octop` | `@seven/<新名>` | profile bundles、`install_bundle`、Forgejo 仓库名 |
| `@seven/dsh-plugin-agents-ui` | 可保持，或 `@seven/<新名>-ui` | 同上 |

- 两个 `package.json` 的 `name`、`description`、README 标题
- `files`/`exports` 里没有硬编码包名，改 name 即可

## 二、cordis 行与插件身份（改了必须一起重启验证）

| 位置 | 现在 |
|---|---|
| `cordis.patch.yml`（octop 包） | `- id: octop` / `name: '@seven/dsh-plugin-octop'` |
| `cordis.patch.yml`（agents-ui 包） | `- id: agents-ui` / `name: '@seven/dsh-plugin-agents-ui'` |
| `lib/index.js` | `export const name = 'octop'`（仅 cordis 诊断用） |
| profile 的 `cordis.patch.yml` | 顶部有 `- id: octop` 配置块（baseUrl/username/password 明文） |

⚠️ **改 row id 会让 profile 里 `- id: octop` 的配置块失配**（凭据丢）。改名前先把那块
复制到临时文件，改完按新 id 放回去，再重启验证 Octop 源能登录。

## 三、面板（客户端插件）

`packages/agents-ui/lib/client.js` 顶部的 `window.__ModuleLoader__.load({ id: '@seven/dsh-plugin-agents-ui', … })`
和这些常量：

- `PANEL_ID = 'octop'`（sidebar 槽位 key；与源 id 无关，可改名）
- `PANEL_TITLE = 'Octop'`、图标 `🐙`
- `SESSION_KEY = 'octop.session'`（localStorage）
- 面板里的中文文案（「给这个专家发消息…」等）

`packages/agents-ui/package.json` 的 `dsh.client` 段不用改（platform/inject）。

## 四、脚本与文档

- `scripts/sync-profile.py`：`SYNC_DIRS` 里写死了 `@seven/dsh-plugin-octop` / `-agents-ui` 目标路径
- `docs/HANDOFF.md`、`README.md`、`docs/MIRROR.md` 里的包名/命令示例
- `tools/mirror.sh` 的目标仓库
- `package.json` 的 `repository` 字段（目前没有，发布前补）

## 五、profile 与安装

- `profiles/ondevice/package.json` 的 `dsh.profile.bundles` 两项
- 安装命令：`install_bundle github:<owner>/<repo>#main&path:/`（根包）与
  `...&path:/packages/agents-ui`（面板）
- 旧包目录 `profiles/ondevice/node_modules/@seven/dsh-plugin-octop` 需要删掉/替换，
  否则新旧两个 bundle 行可能共存

## 六、建议顺序

1. 定名 → 改两个 `package.json` + 两个 `cordis.patch.yml` + `lib/index.js` 的 `name`
2. 同步 profile、改 bundles 列表、迁移 `- id:` 配置块，**重启验证** Octop 源登录 + 面板
3. 改仓库名（Forgejo 新建/改名），`git remote set-url`，推一次
4. 定名前**不要**建 GitHub 镜像、不要发 npm（名字会变）
