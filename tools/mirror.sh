#!/usr/bin/env sh
# 把当前仓库完整镜像到 GitHub（自部署 git 不支持 push mirror 时的兜底方案）。
#
# 用法：
#   GITHUB_TOKEN=ghp_xxx GH_OWNER=your-name GH_REPO=dsh-plugin-octop tools/mirror.sh
#
# 说明：
# - 用 --mirror：分支、标签、删除都同步，GitHub 侧当作纯镜像；
# - GitHub 仓库必须是空仓（或只由本脚本写过），否则首次会冲突；
# - token 走环境变量，不要写进仓库、不要写进脚本。
set -eu

: "${GITHUB_TOKEN:?需要 GITHUB_TOKEN（PAT，Contents 读写）}"
: "${GH_OWNER:?需要 GH_OWNER（GitHub 用户名或组织）}"
: "${GH_REPO:?需要 GH_REPO（GitHub 仓库名）}"

TARGET="https://x-access-token:${GITHUB_TOKEN}@github.com/${GH_OWNER}/${GH_REPO}.git"

echo "镜像到 https://github.com/${GH_OWNER}/${GH_REPO}.git"
git push --mirror "$TARGET"
echo "完成。端侧可装：github.com/${GH_OWNER}/${GH_REPO}"
