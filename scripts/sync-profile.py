#!/usr/bin/env python3
"""把仓库里的插件同步进端侧 profile（手工安装通道）。

背景：DSHM 的进程内安装器只认 npm 包名 / GitHub 仓库地址 / `github:` 简写，
本地 tarball 和自建 Forgejo 的 git URL 都会被拒（实测 2026-11-21）。所以给自建
registry 的插件，端侧落地还是「同步文件 + 重启」——这个脚本把那几步做成一条命令，
带哈希校验，避免再出现「改完忘了同步」或「同步了一半」。

用法（在宿主里跑，可用 python 工具或 bash）：
  python3 scripts/sync-profile.py            # 同步并校验
  python3 scripts/sync-profile.py --check    # 只校验，不写
  python3 scripts/sync-profile.py --profile /path/to/profile

同步完必须重启 DSHM（profile 是 patchReload: startup）。
"""

import argparse
import hashlib
import os
import shutil
import sys

def default_repo():
    """脚本可能在宿主里被 exec 执行（没有 __file__），所以多留几条路。"""
    try:
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        if os.path.isdir(os.path.join(here, 'lib')):
            return here
    except NameError:
        pass
    for candidate in (
        os.environ.get('DSH_OCTOP_REPO', ''),
        '/data/storage/el2/base/haps/phone/files/dsh/home/tmp-repo/dsh-plugin-octop',
        os.getcwd(),
    ):
        if candidate and os.path.isdir(os.path.join(candidate, 'lib')) and os.path.isfile(os.path.join(candidate, 'package.json')):
            return candidate
    return os.getcwd()


REPO_DEFAULT = default_repo()
PROFILE_DEFAULT = os.path.join(
    os.environ.get('DSH_HOME', '/data/storage/el2/base/haps/phone/files/dsh/home'),
    'profiles', 'ondevice',
)

# (源, 目标)：单个文件的映射；目录整体同步见 SYNC_DIRS
SYNC_FILES = [
    ('packages/agents-ui/lib/client.js', 'node_modules/@seven/dsh-plugin-agents-ui/lib/client.js'),
    ('packages/agents-ui/lib/index.js', 'node_modules/@seven/dsh-plugin-agents-ui/lib/index.js'),
]
SYNC_DIRS = [
    ('lib', 'node_modules/@seven/dsh-plugin-octop/lib'),
]


def digest(path):
    hasher = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(65536), b''):
            hasher.update(chunk)
    return hasher.hexdigest()[:12]


def sync_file(source, target, check_only):
    if not os.path.isfile(source):
        return ('missing-source', source, '')
    if not os.path.isfile(target):
        if check_only:
            return ('missing-target', target, '')
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copy2(source, target)
        return ('copied', target, digest(target))
    same = digest(source) == digest(target)
    if same:
        return ('same', target, digest(target))
    if check_only:
        return ('differs', target, '')
    shutil.copy2(source, target)
    return ('copied', target, digest(target))


def sync_dir(source_dir, target_dir, check_only):
    results = []
    if not os.path.isdir(source_dir):
        return [('missing-source', source_dir, '')]
    if not check_only:
        os.makedirs(target_dir, exist_ok=True)
    for name in sorted(os.listdir(source_dir)):
        source = os.path.join(source_dir, name)
        if not os.path.isfile(source):
            continue
        results.append(sync_file(source, os.path.join(target_dir, name), check_only))
    # 反向检查：目标里有源里没有的文件（例如仓库删了某个模块）
    if os.path.isdir(target_dir):
        for name in sorted(os.listdir(target_dir)):
            if name.startswith('.'):
                continue
            if not os.path.isfile(os.path.join(source_dir, name)):
                results.append(('extra-target', os.path.join(target_dir, name), ''))
    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', default=REPO_DEFAULT)
    parser.add_argument('--profile', default=PROFILE_DEFAULT)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()

    repo = os.path.abspath(args.repo)
    profile = os.path.abspath(args.profile)
    if not os.path.isdir(profile):
        print('profile 不存在：%s' % profile, file=sys.stderr)
        return 2

    results = []
    for relative, target in SYNC_FILES:
        results.append(sync_file(os.path.join(repo, relative), os.path.join(profile, target), args.check))
    for source_dir, target_dir in SYNC_DIRS:
        results.extend(sync_dir(os.path.join(repo, source_dir), os.path.join(profile, target_dir), args.check))

    problems = [row for row in results if row[0] in ('differs', 'missing-target', 'extra-target', 'missing-source')]
    for action, path, digest_value in results:
        if action == 'same':
            continue
        print('%-14s %s %s' % (action, path, digest_value))
    if args.check:
        if problems:
            print('不一致 %d 处（跑一次不带 --check 同步）' % len(problems), file=sys.stderr)
            return 1
        print('profile 与仓库一致')
        return 0
    print('同步完成：%d 个文件（%d 个有变化）' % (len([r for r in results if r[0] != 'extra-target']),
                                             len([r for r in results if r[0] == 'copied'])))
    if any(row[0] == 'extra-target' for row in results):
        print('注意：profile 里有仓库已删除的文件，见上面的 extra-target（确认后可手工删）')
    print('记得重启 DSHM（patchReload: startup）')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
