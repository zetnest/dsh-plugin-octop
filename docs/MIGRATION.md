# 会话迁移：手机 → 电脑

## 现成能力

- **导出**：Web 端有会话日志下载。服务端路由 `/api/session.export?sessionId=<id>&includeDescendants=true|false`
  返回 ZIP；浏览器侧入口是会话内 `/export` 命令（和日志下载对话框）。
- ZIP 内容（源码 `dsh-session-log-export/src/archive.ts`）：
  - 根会话：canonical JSONL，名字 `session.vN.jsonl`（当前 v4）
  - 子会话：`subagents/<id>/session.vN.jsonl`
  - 图片：`media/<attachmentId>.<ext>`（内容寻址）；普通文件：`files/<prefix>/<digest>/<name>`
  - **没有 manifest**，目录结构就是约定
- **没有**「一键导入到另一台机器」的 UI；导入要靠文件落位（见下）。

## 手工迁移步骤

1. **手机导出**：打开要迁的会话 → 输入 `/export`（或设置里的会话日志下载）→ 得到 ZIP →
   用 USB / 网盘 / AirDrop 传到电脑。
2. **电脑准备**：装同版本 DSH（本机是 `0.2.2-rc.5+dshm.1`，会话格式 v4）。先正常打开一次，
   让 sessions 根目录建好。
3. **落位**：解压 ZIP，把 `session.v4.jsonl` 放到
   `<sessions-root>/<任意项目目录>/<session-id>/session.v4.jsonl`
   - sessions 根目录由部署配置的 `root` 指定（本机是 `$DSH_HOME/sessions`；桌面端以它的配置为准）
   - JSONL 后端同时接受 `.jsonl` 与 `.jsonl.zstd`，未压缩文件能直接识别；首次写入时按桌面配置压缩/迁移
   - 子会话保持 `subagents/<id>/session.v4.jsonl` 的相对位置
4. **可选但建议**：把 JSONL **第一行 header** 里的 `cwd` 改成电脑上的路径。
   手机路径在电脑上不存在，恢复后工具的工作目录会指向无效路径（聊天本身仍可继续）。
5. 启动 DSH → 在会话列表里找到它 → 继续对话。

## 坑

- 会话格式版本必须匹配（当前 v4）。跨大版本可能被拒绝，先升/降版本再迁。
- 附件只带原始字节：桌面端的 attachment store 需要单独导入（目前没有自动导入器）；
  纯文本会话不受影响。
- 项目目录名：手机端按工作区路径编码，桌面端会按自己的工作区重新分组；放任意项目目录下即可被列出。
- 端侧直接 HTTP 调 `/api/session.export` 实测 404（cookie 认证是通的），优先用会话内 `/export` 命令。
  若命令也不可用，退路是直接读 `$DSH_HOME/sessions/<项目>/<session-id>/session.v4.jsonl.zstd`
  解压成 JSONL（宿主的 zstd 可用，插件里加个导出脚本即可）。
