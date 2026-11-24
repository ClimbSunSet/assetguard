<#
.SYNOPSIS
  AssetGuard MVP - Git 머지 충돌이 난 DataTable(JSON/CSV)을 칸 단위로 합치는 로컬 도구.

.DESCRIPTION
  머지 충돌 상태인 Git 저장소에서 실행하면
    1) 충돌 난 DataTable 파일의 공통 원본/내 버전/상대 버전을 Git에서 꺼내고
    2) 이 PC에서만 열리는 병합 화면(http://localhost)을 브라우저로 띄운 뒤
    3) 저장하면 결과 파일을 쓰고 git add 까지 해 줍니다.
  서버나 설치가 필요 없고 Windows 기본 PowerShell + Git만 씁니다. 에셋은 PC 밖으로 나가지 않습니다.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File assetguard.ps1            # 현재 폴더의 저장소
  powershell -ExecutionPolicy Bypass -File assetguard.ps1 -Repo D:\MyGame
  git assetguard                                                      # install.ps1 로 별칭 등록 후
#>
[CmdletBinding()]
param(
  [string]$Repo = (Get-Location).Path,
  [int]$Port = 47813,
  [switch]$NoBrowser,
  # Git 없이 화면/테스트 파일만 띄움 (개발용)
  [switch]$ServeOnly
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$ToolRoot = $PSScriptRoot
$Utf8NoBom = New-Object Text.UTF8Encoding $false
$Utf8Strict = New-Object Text.UTF8Encoding($false, $true)   # throws on invalid bytes instead of writing U+FFFD
$script:Token = [guid]::NewGuid().ToString('N')              # ties the browser tab to this run
$DataTableExt = @('.json', '.csv')

function Write-Info($msg) { Write-Host "[AssetGuard] $msg" }

# ---------- Git 호출 (UTF-8 그대로 읽기 위해 Process 사용) ----------
function Quote-Arg([string]$a) {
  if ($a -eq '') { return '""' }
  if ($a -notmatch '[\s"]') { return $a }
  return '"' + ($a -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Invoke-Git {
  param([string[]]$GitArgs, [switch]$AllowFail, [switch]$Bytes)
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = 'git'
  $psi.Arguments = (@('-C', $script:RepoRoot) + $GitArgs | ForEach-Object { Quote-Arg $_ }) -join ' '
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $p = [Diagnostics.Process]::Start($psi)
  $ms = New-Object IO.MemoryStream
  $errTask = $p.StandardError.ReadToEndAsync()
  $p.StandardOutput.BaseStream.CopyTo($ms)
  $p.WaitForExit()
  if ($p.ExitCode -ne 0 -and -not $AllowFail) {
    throw "git $($GitArgs -join ' ') 실패: $($errTask.Result)"
  }
  if ($p.ExitCode -ne 0) { return $null }
  $raw = $ms.ToArray()
  if ($Bytes) { return , $raw }
  return $Utf8NoBom.GetString($raw)
}

# Decode a blob without ever guessing: UTF-8 (with/without BOM) and UTF-16 with BOM are read
# exactly; anything else (CP949 from Excel, UTF-16 without BOM, binary) is refused.
function Get-Blob([string]$sha) {
  $bytes = Invoke-Git -GitArgs @('cat-file', 'blob', $sha) -Bytes
  if ($null -eq $bytes) { $bytes = [byte[]]@() }
  $n = $bytes.Length
  try {
    if ($n -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
      $enc = 'utf8bom'; $text = $Utf8Strict.GetString($bytes, 3, $n - 3)
    } elseif ($n -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
      $enc = 'utf16le'; $text = (New-Object Text.UnicodeEncoding($false, $false, $true)).GetString($bytes, 2, $n - 2)
    } elseif ($n -ge 2 -and $bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF) {
      $enc = 'utf16be'; $text = (New-Object Text.UnicodeEncoding($true, $false, $true)).GetString($bytes, 2, $n - 2)
    } else {
      $enc = 'utf8'; $text = $Utf8Strict.GetString($bytes)
    }
  } catch {
    return @{ error = 'UTF-8이 아닌 인코딩(CP949 등)이라 안전하게 읽을 수 없어요. UTF-8로 저장해서 커밋한 뒤 다시 시도하세요.' }
  }
  if ($text.IndexOf([char]0) -ge 0) { return @{ error = 'BOM 없는 UTF-16 또는 바이너리 파일로 보여요. UTF-8로 저장한 뒤 다시 시도하세요.' } }
  if ($text.StartsWith('version https://git-lfs.github.com/spec/')) { return @{ error = 'Git LFS 포인터 파일이에요. LFS 파일은 아직 지원하지 않아요.' } }
  return @{ text = $text; encoding = $enc }
}

function Get-Encoding([string]$name) {
  switch ($name) {
    'utf8bom' { return New-Object Text.UTF8Encoding $true }
    'utf16le' { return New-Object Text.UnicodeEncoding($false, $true) }
    'utf16be' { return New-Object Text.UnicodeEncoding($true, $true) }
    default { return $Utf8NoBom }
  }
}

function Test-GitPath([string]$name) {
  $p = Invoke-Git -GitArgs @('rev-parse', '--git-path', $name) -AllowFail
  if (-not $p) { return $null }
  $full = [IO.Path]::GetFullPath((Join-Path $script:RepoRoot $p.Trim()))
  if (Test-Path -LiteralPath $full) { return $full }
  return $null
}

function Get-Ref([string]$ref) {
  $v = Invoke-Git -GitArgs @('rev-parse', '-q', '--verify', $ref) -AllowFail
  if ($v) { return $v.Trim() }
  return $null
}

function Get-RefLabel([string]$rev) {
  $n = Invoke-Git -GitArgs @('name-rev', '--name-only', '--exclude=tags/*', $rev) -AllowFail
  if ($n) { $n = ($n.Trim() -replace '[~^]\d*$', '' -replace '^remotes/', '') }
  if (-not $n -or $n -eq 'undefined') { $n = (Invoke-Git -GitArgs @('rev-parse', '--short', $rev)).Trim() }
  return $n
}

# Which operation produced the conflict, and which index stage is "me" vs "them".
# merge / cherry-pick / revert / stash: stage 2 = HEAD = me.  rebase: stage 2 = upstream, stage 3 = my commit.
function Get-Operation {
  $branch = (Invoke-Git -GitArgs @('rev-parse', '--abbrev-ref', 'HEAD')).Trim()
  if (Get-Ref 'MERGE_HEAD') {
    $base = Invoke-Git -GitArgs @('merge-base', 'HEAD', 'MERGE_HEAD') -AllowFail
    return @{ op = 'merge'; meStage = 2; themStage = 3; me = $branch; them = (Get-RefLabel 'MERGE_HEAD')
              meRev = 'HEAD'; themRev = 'MERGE_HEAD'; baseRev = $(if ($base) { $base.Trim() } else { $null }) }
  }
  $rebaseDir = Test-GitPath 'rebase-merge'
  if (-not $rebaseDir) { $rebaseDir = Test-GitPath 'rebase-apply' }
  if ($rebaseDir) {
    $headName = Join-Path $rebaseDir 'head-name'
    $me = if (Test-Path -LiteralPath $headName) { ([IO.File]::ReadAllText($headName)).Trim() -replace '^refs/heads/', '' } else { '내 커밋' }
    $ontoFile = Join-Path $rebaseDir 'onto'
    $them = if (Test-Path -LiteralPath $ontoFile) { Get-RefLabel (([IO.File]::ReadAllText($ontoFile)).Trim()) } else { 'upstream' }
    return @{ op = 'rebase'; meStage = 3; themStage = 2; me = "$me (rebase 중인 내 커밋)"; them = $them
              meRev = $(if (Get-Ref 'REBASE_HEAD') { 'REBASE_HEAD' } else { $null }); themRev = 'HEAD'; baseRev = $null }
  }
  if (Get-Ref 'CHERRY_PICK_HEAD') {
    return @{ op = 'cherry-pick'; meStage = 2; themStage = 3; me = $branch; them = 'cherry-pick ' + (Get-RefLabel 'CHERRY_PICK_HEAD')
              meRev = 'HEAD'; themRev = 'CHERRY_PICK_HEAD'; baseRev = $null }
  }
  if (Get-Ref 'REVERT_HEAD') {
    return @{ op = 'revert'; meStage = 2; themStage = 3; me = $branch; them = '되돌리는 커밋 ' + (Get-RefLabel 'REVERT_HEAD')
              meRev = 'HEAD'; themRev = $null; baseRev = $null }
  }
  return @{ op = 'other'; meStage = 2; themStage = 3; me = $branch; them = '다른 버전 (stash 등)'; meRev = 'HEAD'; themRev = $null; baseRev = $null }
}

function Get-LastCommit([string]$rev, [string]$path) {
  $line = Invoke-Git -GitArgs @('log', '-1', '--format=%h%x09%an%x09%ar%x09%s', $rev, '--', $path) -AllowFail
  if (-not $line) { return $null }
  $parts = $line.Trim() -split "`t", 4
  if ($parts.Count -lt 4) { return $null }
  return @{ hash = $parts[0]; author = $parts[1]; when = $parts[2]; subject = $parts[3] }
}

# ---------- 충돌 세션 만들기 ----------
function New-Session {
  $unmerged = Invoke-Git -GitArgs @('ls-files', '-u', '-z')
  $byPath = [ordered]@{}
  foreach ($entry in ($unmerged -split "`0")) {
    if (-not $entry) { continue }
    # "<mode> <sha> <stage>\t<path>"
    $meta, $path = $entry -split "`t", 2
    $mode, $sha, $stage = $meta -split ' '
    if (-not $byPath.Contains($path)) { $byPath[$path] = @{} }
    $byPath[$path][[int]$stage] = $sha
  }

  $op = Get-Operation

  $files = @(); $skipped = @()
  foreach ($path in $byPath.Keys) {
    $ext = [IO.Path]::GetExtension($path).ToLower()
    if ($DataTableExt -notcontains $ext) {
      $reason = if ($ext -eq '.uasset') { '.uasset 직접 병합은 다음 단계(언리얼 에디터 연동)에서 지원 예정' } else { 'DataTable(JSON/CSV) 파일이 아님' }
      $skipped += @{ path = $path; reason = $reason }
      continue
    }
    $stages = $byPath[$path]
    if (-not $stages.ContainsKey($op.meStage) -or -not $stages.ContainsKey($op.themStage)) {
      $who = if ($stages.ContainsKey($op.meStage)) { '상대' } else { '내' }
      $skipped += @{ path = $path; reason = "$who 쪽에서 파일을 삭제했어요. 파일을 남길지(git add) 지울지(git rm) 먼저 정하세요." }
      continue
    }
    $blobs = @{}
    $err = $null
    foreach ($s in @(1, $op.meStage, $op.themStage)) {
      if (-not $stages.ContainsKey($s)) { continue }
      $blobs[$s] = Get-Blob $stages[$s]
      if ($blobs[$s].error) { $err = $blobs[$s].error }
    }
    if ($err) { $skipped += @{ path = $path; reason = $err }; continue }
    $f = @{ path = $path; base = $null; ours = $blobs[$op.meStage].text; theirs = $blobs[$op.themStage].text
            encoding = $blobs[$op.meStage].encoding; commits = @{} }
    if ($blobs.ContainsKey(1)) { $f.base = $blobs[1].text }
    if ($op.meRev) { $f.commits.ours = Get-LastCommit $op.meRev $path }
    if ($op.themRev) { $f.commits.theirs = Get-LastCommit $op.themRev $path }
    if ($op.baseRev) { $f.commits.base = Get-LastCommit $op.baseRev $path }
    $files += $f
  }

  return @{
    mode = 'git'
    token = $script:Token
    repo = $script:RepoRoot
    op = $op.op
    labels = @{ base = '공통 원본'; ours = $op.me; theirs = $op.them }
    files = $files
    skipped = $skipped
  }
}

# ---------- HTTP ----------
$ContentTypes = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'application/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json; charset=utf-8'
  '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.ico' = 'image/x-icon'
}

function Send-Bytes($res, [byte[]]$bytes, [string]$type, [int]$status = 200) {
  $res.StatusCode = $status
  $res.ContentType = $type
  $res.Headers['Cache-Control'] = 'no-store'
  $res.ContentLength64 = $bytes.Length
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
  $res.OutputStream.Close()
}
function Send-Json($res, $obj, [int]$status = 200) {
  $json = ConvertTo-Json -InputObject $obj -Depth 12 -Compress
  Send-Bytes $res ($Utf8NoBom.GetBytes($json)) 'application/json; charset=utf-8' $status
}
function Read-Body($req) {
  $reader = New-Object IO.StreamReader($req.InputStream, $Utf8NoBom)
  try { return $reader.ReadToEnd() } finally { $reader.Close() }
}

function Serve-Static($res, [string]$urlPath) {
  if ($urlPath -eq '/') { $urlPath = '/web/index.html' }
  $rel = [Uri]::UnescapeDataString($urlPath.TrimStart('/')) -replace '/', '\'
  $full = [IO.Path]::GetFullPath((Join-Path $ToolRoot $rel))
  $allowed = @((Join-Path $ToolRoot 'web'), (Join-Path $ToolRoot 'tests')) | ForEach-Object { [IO.Path]::GetFullPath($_) + '\' }
  $ok = $false
  foreach ($a in $allowed) { if ($full.StartsWith($a, [StringComparison]::OrdinalIgnoreCase)) { $ok = $true } }
  if (-not $ok -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
    Send-Bytes $res ($Utf8NoBom.GetBytes('Not found')) 'text/plain; charset=utf-8' 404; return
  }
  $ext = [IO.Path]::GetExtension($full).ToLower()
  $type = if ($ContentTypes.ContainsKey($ext)) { $ContentTypes[$ext] } else { 'application/octet-stream' }
  Send-Bytes $res ([IO.File]::ReadAllBytes($full)) $type
}

function Assert-Token($data) {
  if (-not $data -or [string]$data.token -ne $script:Token) {
    throw '다른 실행에서 열린 화면이에요. 이 탭을 닫고 터미널에 표시된 주소를 새로 여세요.'
  }
}

function Resolve-File($body) {
  $data = $body | ConvertFrom-Json
  Assert-Token $data
  $path = [string]$data.path
  $file = $script:Session.files | Where-Object { $_.path -eq $path } | Select-Object -First 1
  if (-not $file) { throw "세션에 없는 파일: $path" }
  # The file must still be unmerged; otherwise someone resolved it another way meanwhile.
  $still = Invoke-Git -GitArgs @('ls-files', '-u', '--', $path)
  if (-not $file.resolved -and -not $still) { throw "$path 는 이미 다른 방법으로 해결됐어요. 덮어쓰지 않았어요." }
  $target = [IO.Path]::GetFullPath((Join-Path $script:RepoRoot $path))
  [IO.File]::WriteAllText($target, [string]$data.content, (Get-Encoding $file.encoding))
  Invoke-Git -GitArgs @('add', '--', $path) | Out-Null
  $file.resolved = $true
  Write-Info "저장 + git add: $path"
  Write-Metrics $path $data.metrics
}

# 파일럿 측정용 기록. .git 폴더 안이라 커밋되지 않고 PC 밖으로 나가지 않습니다.
function Write-Metrics([string]$path, $metrics) {
  if (-not $metrics) { return }
  try {
    $gitDir = (Invoke-Git -GitArgs @('rev-parse', '--absolute-git-dir')).Trim()
    $entry = [ordered]@{
      time = (Get-Date).ToString('s'); file = $path
      ours = $script:Session.labels.ours; theirs = $script:Session.labels.theirs
      metrics = $metrics
    }
    $line = (ConvertTo-Json -InputObject $entry -Depth 6 -Compress) + "`n"
    [IO.File]::AppendAllText((Join-Path $gitDir 'assetguard-log.jsonl'), $line, $Utf8NoBom)
  } catch { Write-Info "기록 실패(병합에는 영향 없음): $($_.Exception.Message)" }
}

# ---------- 시작 ----------
if ($ServeOnly) {
  $script:RepoRoot = $ToolRoot
  $script:Session = @{ mode = 'none'; files = @(); skipped = @() }
} else {
  # Invoke-Git (not `& git ... 2>$null`): in PS 5.1 with ErrorActionPreference=Stop,
  # redirected native stderr throws before we can print a friendly message.
  $script:RepoRoot = [IO.Path]::GetFullPath($Repo)
  $top = if (Test-Path -LiteralPath $script:RepoRoot -PathType Container) { Invoke-Git -GitArgs @('rev-parse', '--show-toplevel') -AllowFail } else { $null }
  if (-not $top) { Write-Info "Git 저장소가 아니에요: $Repo"; exit 1 }
  $script:RepoRoot = [IO.Path]::GetFullPath($top.Trim())
  $script:Session = New-Session
  if ($script:Session.files.Count -eq 0) {
    Write-Info '병합할 DataTable 충돌이 없어요.'
    foreach ($s in $script:Session.skipped) { Write-Info "  건너뜀: $($s.path) ($($s.reason))" }
    exit 0
  }
  Write-Info "충돌 DataTable $($script:Session.files.Count)개: $(( $script:Session.files | ForEach-Object { $_.path }) -join ', ')"
  foreach ($s in $script:Session.skipped) { Write-Info "  건너뜀: $($s.path) ($($s.reason))" }
}

# Try the requested port and the next 9, so two repos can be open at once.
$listener = $null; $prefix = $null
for ($p = $Port; $p -lt $Port + 10; $p++) {
  $l = New-Object Net.HttpListener
  $l.Prefixes.Add("http://localhost:$p/")
  try { $l.Start(); $listener = $l; $prefix = "http://localhost:$p/"; break } catch { $l.Close() }
}
if (-not $listener) { Write-Info "포트 $Port~$($Port + 9) 를 열 수 없어요. -Port 로 다른 번호를 지정해 보세요."; exit 1 }
Write-Info "병합 화면: $prefix  (끝내려면 화면의 '완료' 또는 Ctrl+C)"
if (-not $NoBrowser) { Start-Process $prefix | Out-Null }

$running = $true
try {
  while ($running -and $listener.IsListening) {
    # Poll instead of blocking in GetContext() so Ctrl+C is handled right away.
    $async = $listener.BeginGetContext($null, $null)
    while (-not $async.AsyncWaitHandle.WaitOne(300)) { }
    $ctx = $listener.EndGetContext($async)
    $req = $ctx.Request; $res = $ctx.Response
    try {
      $path = $req.Url.AbsolutePath
      $origin = $req.Headers['Origin']
      if ($req.HttpMethod -eq 'POST' -and $origin -and $origin.TrimEnd('/') -ne $prefix.TrimEnd('/')) {
        # Other web pages open in the browser must not be able to write files through this server.
        Send-Json $res @{ ok = $false; error = 'forbidden origin' } 403
      } elseif ($req.HttpMethod -eq 'HEAD') {
        # Readiness checks: answer without a body (HttpListener rejects body writes on HEAD).
        $res.StatusCode = 200; $res.Close()
      } elseif ($path -eq '/api/session' -and $req.HttpMethod -eq 'GET') {
        Send-Json $res $script:Session
      } elseif ($path -eq '/api/resolve' -and $req.HttpMethod -eq 'POST') {
        Resolve-File (Read-Body $req)
        Send-Json $res @{ ok = $true }
      } elseif ($path -eq '/api/quit' -and $req.HttpMethod -eq 'POST') {
        if (-not $ServeOnly) { Assert-Token ((Read-Body $req) | ConvertFrom-Json) }
        Send-Json $res @{ ok = $true }
        $running = $false
      } elseif ($req.HttpMethod -eq 'GET') {
        Serve-Static $res $path
      } else {
        Send-Json $res @{ ok = $false; error = 'not found' } 404
      }
    } catch {
      Write-Info "오류: $($_.Exception.Message)"
      try { Send-Json $res @{ ok = $false; error = $_.Exception.Message } 500 } catch {}
    }
  }
} finally {
  $listener.Stop(); $listener.Close()
}

if (-not $ServeOnly) {
  $left = @($script:Session.files | Where-Object { -not $_.resolved })
  if ($left.Count -eq 0) {
    $next = switch ($script:Session.op) { 'rebase' { 'git rebase --continue' } 'cherry-pick' { 'git cherry-pick --continue' } 'revert' { 'git revert --continue' } default { 'git commit' } }
    Write-Info "모든 DataTable 충돌을 해결했어요. 남은 충돌이 없으면 $next 로 마무리하세요."
  } else {
    Write-Info "아직 해결 안 된 파일: $(($left | ForEach-Object { $_.path }) -join ', ')"
  }
}
