# DSH 会话迁移（Windows / DSH NEXT）
#
# 用法（PowerShell，普通用户即可）：
#   1) 解压下载的会话 ZIP 后，确认里面有 session.v4.jsonl
#   2) 右键 → 使用 PowerShell 运行，或：
#      powershell -ExecutionPolicy Bypass -File .\import-dsh-session.ps1 -Zip "C:\path\session.zip"
#
# 它做四件事：
#   1. 找到 DSH NEXT 的 dsh-home（%APPDATA% 下含 sessions 目录的那个）
#   2. 解包 ZIP 到临时目录
#   3. 把每个 session.v4.jsonl 第一行 header 的 cwd 改成 Windows 路径
#   4. 按 <dsh-home>\sessions\<工作区>\<session-id>\session.v4.jsonl 落位（子会话也平铺）
#
# 参数：
#   -Zip            会话 ZIP 路径（必填）
#   -DshHome        手动指定 dsh-home（自动探测失败时用）
#   -WorkspaceSlug  指定落到哪个已有工作区目录（默认取最近修改的会话目录的父目录）
#   -Cwd            新的工作目录（默认 $env:USERPROFILE\Documents，不存在则不传）

param(
  [Parameter(Mandatory = $true)][string]$Zip,
  [string]$DshHome = '',
  [string]$WorkspaceSlug = '',
  [string]$Cwd = ''
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Zip)) { throw "ZIP 不存在：$Zip" }
if (-not $Cwd) {
  $docs = Join-Path $env:USERPROFILE 'Documents'
  if (Test-Path -LiteralPath $docs) { $Cwd = $docs }
}

# 1) 找 dsh-home：%APPDATA% 下任意层级的 dsh-home\sessions
if (-not $DshHome) {
  $candidates = Get-ChildItem -Path $env:APPDATA -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'dsh|harness' } |
    ForEach-Object { Get-ChildItem -Path $_.FullName -Directory -ErrorAction SilentlyContinue } |
    Where-Object { $_.Name -eq 'dsh-home' }
  if (-not $candidates) {
    $candidates = Get-ChildItem -Path $env:APPDATA -Directory -Recurse -Depth 3 -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -eq 'dsh-home' }
  }
  $withSessions = $candidates | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'sessions') }
  if (-not $withSessions) {
    throw "没找到 dsh-home（含 sessions 目录）。请用 -DshHome 指定，例如 -DshHome '$env:APPDATA\<产品名>\dsh-home'"
  }
  $DshHome = ($withSessions | Select-Object -First 1).FullName
}
$sessionsRoot = Join-Path $DshHome 'sessions'
Write-Host "dsh-home: $DshHome"

# 2) 解包
$tmp = Join-Path $env:TEMP ('dsh-import-' + [Guid]::NewGuid().ToString('n').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
Expand-Archive -LiteralPath $Zip -DestinationPath $tmp -Force
$logs = Get-ChildItem -Path $tmp -Recurse -Filter 'session.v4.jsonl'
if (-not $logs) {
  $logs = Get-ChildItem -Path $tmp -Recurse -Filter '*.jsonl'
}
if (-not $logs) { throw "ZIP 里没有 session*.jsonl，确认导出的是会话日志 ZIP" }

# 3) 选工作区 slug
if (-not $WorkspaceSlug) {
  $latest = Get-ChildItem -Path $sessionsRoot -Directory -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $WorkspaceSlug = if ($latest) { $latest.Name } else { 'imported' }
}
$workspaceDir = Join-Path $sessionsRoot $WorkspaceSlug
New-Item -ItemType Directory -Force -Path $workspaceDir | Out-Null
Write-Host "工作区: $WorkspaceSlug"

# 4) 改 cwd + 落位
$imported = 0
foreach ($log in $logs) {
  $lines = Get-Content -LiteralPath $log.FullName -Encoding UTF8
  if ($lines.Count -eq 0) { continue }
  $header = $lines[0] | ConvertFrom-Json
  $sessionId = [string]$header.id
  if (-not $sessionId) {
    Write-Warning "跳过（header 里没有 id）：$($log.FullName)"
    continue
  }
  if ($Cwd -and ($header.PSObject.Properties.Name -contains 'cwd')) {
    $header.cwd = $Cwd
    $lines[0] = ($header | ConvertTo-Json -Compress -Depth 100)
  }
  $isSubagent = $log.DirectoryName -match '[\\/]subagents[\\/]'
  $targetDir = Join-Path $workspaceDir $sessionId
  New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
  $targetFile = Join-Path $targetDir 'session.v4.jsonl'
  # 必须写 UTF-8 无 BOM：JSONL 解析器按行 JSON.parse，BOM 会让第一行解析失败
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllLines($targetFile, [string[]]$lines, $utf8NoBom)
  $kind = if ($isSubagent) { '子会话' } else { '会话' }
  Write-Host ("导入{0}: {1} -> {2}" -f $kind, $sessionId, $targetFile)
  $imported++
}

# 5) 附件（可选）：ZIP 里的 media/ 和 files/ 需要放到桌面端的附件库；
#    目前没有自动导入器，先提示。
$media = Get-ChildItem -Path $tmp -Recurse -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -eq 'media' -or $_.Name -eq 'files' } | Select-Object -First 1
if ($media) {
  Write-Warning "ZIP 里含附件（media/files）。桌面端附件库没有自动导入器，本次只导了会话文本；"
  Write-Warning "附件目录在：$($media.Parent.FullName)"
}

Write-Host ""
Write-Host "完成：$imported 个日志已落位。"
Write-Host "下一步：重启 DSH NEXT，在「$WorkspaceSlug」工作区里应该能看到这条会话。"
if (-not $Cwd) { Write-Host "注意：没有设置 -Cwd，header 里的工作目录仍是手机路径，工具的工作目录会无效。" }
