# 分发：自部署 git 主仓 + GitHub 只读镜像

## 为什么是这套

端侧安装器（实测）只认两种 spec：**npm registry 里的包名**、**`github.com/owner/repo`**。
自部署 git 的 URL、tarball 直链、`git+http` 一律被拒（报错「无法识别的插件标识」）。

所以分工是：

```
自部署 git（唯一写入口，主仓）
        │  自动 push（镜像）
        ▼
GitHub 公开仓库（只读镜像）
        │  DSHM 安装器唯一认得的地址
        ▼
DSHM 端侧：pnpm add github.com/<owner>/<repo>
```

镜像必须**单向**：所有提交只在主仓做，GitHub 侧不要直接改，否则下次镜像会被覆盖。

## 0. 一次性准备

1. GitHub 建**空仓库**（不要勾 README / .gitignore / license，否则首次镜像会冲突）。
2. GitHub 建 PAT：
   - fine-grained token：仅该仓库，权限 `Contents: Read and write`；
   - 或 classic token：`repo` 范围。
3. token 只放在自部署服务的镜像配置或环境变量里，**绝不进仓库**（`.gitignore` 已挡 `.env` / `octop-m0.json`）。

## 1. 主仓第一次提交

```bash
git init -b main
git add .
git commit -m "feat: dsh-plugin-octop 0.1.0（Octop 专家对话/线程/审批）"
git remote add origin <你的自部署 git 地址>
git push -u origin main
```

## 2. 挂自动镜像（三选一）

### A. Gitea push mirror（推荐，零额外进程）

仓库 → **设置 → 仓库 → 镜像设置**（Push Mirror）→ 添加推送镜像：

- 目标 URL：`https://<你的GitHub用户名>:<token>@github.com/<owner>/<repo>.git`
- 勾选「同步时删除远端不存在的分支」（镜像语义）
- 同步间隔：按需（8h 或手动触发）

### B. GitLab push mirroring

Settings → **Repository → Mirroring repositories**：

- Git repository URL：`https://oauth2:<token>@github.com/<owner>/<repo>.git`
- Mirror direction：**Push**
- 勾选 “Only mirror protected branches” **不要勾**（我们要完整镜像）

### C. 服务端 hook / 本机脚本（自部署 git 不支持 mirror 时）

裸仓 `hooks/post-receive` 里调 `tools/mirror.sh`，或者在你自己的机器上定时跑：

```bash
GITHUB_TOKEN=xxx GH_OWNER=your-name GH_REPO=dsh-plugin-octop tools/mirror.sh
```

## 3. 端侧安装

```bash
pnpm add github.com/<owner>/<repo>
```

装完**重启 DSHM 应用**才挂载。然后：

- 设置 → 插件 里应能看到 `dsh-plugin-octop`；
- 让模型调 `octop_status` 自检，再 `octop_experts` 看专家。

注意：

- **仓库要公开**。私有仓需要鉴权，端侧安装器支不支持 token 我没验证过，别赌。
- 安装器支持指定分支/子目录：`github.com/<owner>/<repo>#main`、`...&path:/子目录`。
  当前包就在仓库根，不需要 path。

## 4. 改了代码之后

主仓提交 → 等镜像同步（或手动触发）→ 端侧重新 `pnpm add github.com/<owner>/<repo>`（同版本号时安装器可能判定已装，必要时先在设置里停用再装）→ 重启应用。

版本号建议跟着改（`package.json` 的 `version`），便于排查装的是哪一版。
