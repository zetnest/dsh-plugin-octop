#!/usr/bin/env python3
"""把插件包打成一个 npm 风格的 .tgz（顶层目录名固定为 package/）。

为什么不用 npm pack：端侧 guest 里没有 npm，仓库又要求零依赖；tarfile 足够，
而且可以精确控制包含哪些文件（lib / cordis.patch.yml / package.json / README / LICENSE）。

用法：
  python3 scripts/pack-tgz.py --dir . --out dist/dsh-plugin-octop-0.1.0.tgz
  python3 scripts/pack-tgz.py --dir packages/agents-ui --out dist/dsh-plugin-agents-ui-0.1.0.tgz
"""

import argparse
import json
import os
import tarfile
import sys

# 打进包里的路径（相对包目录）；不存在的自动跳过
INCLUDE = ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'lib']


def collect(root):
    """按 INCLUDE 展开文件列表，保持稳定顺序。"""
    files = []
    for entry in INCLUDE:
        path = os.path.join(root, entry)
        if not os.path.exists(path):
            continue
        if os.path.isdir(path):
            for base, dirs, names in os.walk(path):
                dirs.sort()
                for name in sorted(names):
                    full = os.path.join(base, name)
                    if os.path.isfile(full):
                        files.append(full)
        elif os.path.isfile(path):
            files.append(path)
    return files


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dir', required=True, help='包目录（含 package.json）')
    parser.add_argument('--out', required=True, help='输出 .tgz 路径')
    args = parser.parse_args()

    root = os.path.abspath(args.dir)
    manifest_path = os.path.join(root, 'package.json')
    with open(manifest_path, encoding='utf-8') as handle:
        manifest = json.load(handle)
    name = manifest.get('name') or ''
    version = manifest.get('version') or ''
    if not name or not version:
        print('package.json 缺少 name/version', file=sys.stderr)
        return 2

    files = collect(root)
    if not files:
        print('没有可打包的文件', file=sys.stderr)
        return 2

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or '.', exist_ok=True)
    with tarfile.open(args.out, 'w:gz') as tar:
        for full in files:
            relative = os.path.relpath(full, root).replace(os.sep, '/')
            info = tar.gettarinfo(full, arcname='package/' + relative)
            info.uid = info.gid = 0
            info.uname = info.gname = ''
            with open(full, 'rb') as handle:
                tar.addfile(info, handle)

    print('packed %s@%s -> %s (%d files, %d bytes)'
          % (name, version, args.out, len(files), os.path.getsize(args.out)))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
