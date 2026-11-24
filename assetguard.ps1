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

function Get-Blob([string]$sha) {
  $bytes = Invoke-Git -GitArgs @('cat-file', 'blob', $sha) -Bytes
  $bom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $start = if ($bom) { 3 } else { 0 }
  return @{ text = $Utf8NoBom.GetString($bytes, $start, $bytes.Length - $start); bom = $bom }
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

  $ours = (Invoke-Git -GitArgs @('rev-parse', '--abbrev-ref', 'HEAD')).Trim()
  $hasMergeHead = $null -ne (Invoke-Git -GitArgs @('rev-parse', '-q', '--verify', 'MERGE_HEAD') -AllowFail)
  $theirsRev = if ($hasMergeHead) { 'MERGE_HEAD' } else { $null }
  $theirs = if ($hasMergeHead) { ((Invoke-Git -GitArgs @('name-rev', '--name-only', 'MERGE_HEAD')).Trim() -replace '~\d+$', '') } else { '상대 버전' }
  $baseRev = if ($hasMergeHead) { (Invoke-Git -GitArgs @('merge-base', 'HEAD', 'MERGE_HEAD') -AllowFail) } else { $null }
  if ($baseRev) { $baseRev = $baseRev.Trim() }

  $files = @(); $skipped = @()
  foreach ($path in $byPath.Keys) {
    $ext = [IO.Path]::GetExtension($path).ToLower()
    if ($DataTableExt -notcontains $ext) {
      $reason = if ($ext -eq '.uasset') { '.uasset 직접 병합은 다음 단계(언리얼 에디터 연동)에서 지원 예정' } else { 'DataTable(JSON/CSV) 파일이 아님' }
      $skipped += @{ path = $path; reason = $reason }
      continue
    }
    $stages = $byPath[$path]
    $f = @{ path = $path; base = $null; ours = $null; theirs = $null; bom = $false; commits = @{} }
    if ($stages.ContainsKey(1)) { $f.base = (Get-Blob $stages[1]).text }
    if ($stages.ContainsKey(2)) { $b = Get-Blob $stages[2]; $f.ours = $b.text; $f.bom = $b.bom }
    if ($stages.ContainsKey(3)) { $f.theirs = (Get-Blob $stages[3]).text }
    $f.commits.ours = Get-LastCommit 'HEAD' $path
    if ($theirsRev) { $f.commits.theirs = Get-LastCommit $theirsRev $path }
    if ($baseRev) { $f.commits.base = Get-LastCommit $baseRev $path }
    $files += $f
  }

  return @{
    mode = 'git'
    repo = $script:RepoRoot
    labels = @{ base = '공통 원본'; ours = $ours; theirs = $theirs }
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

function Resolve-File($body) {
  $data = $body | ConvertFrom-Json
  $path = [string]$data.path
  $file = $script:Session.files | Where-Object { $_.path -eq $path } | Select-Object -First 1
  if (-not $file) { throw "세션에 없는 파일: $path" }
  $target = [IO.Path]::GetFullPath((Join-Path $script:RepoRoot $path))
  $enc = if ($file.bom) { New-Object Text.UTF8Encoding $true } else { $Utf8NoBom }
  [IO.File]::WriteAllText($target, [string]$data.content, $enc)
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
  $script:RepoRoot = (& git -C $Repo rev-parse --show-toplevel 2>$null)
  if (-not $script:RepoRoot) { Write-Info "Git 저장소가 아니에요: $Repo"; exit 1 }
  $script:RepoRoot = [IO.Path]::GetFullPath($script:RepoRoot.Trim())
  $script:Session = New-Session
  if ($script:Session.files.Count -eq 0) {
    Write-Info '병합할 DataTable 충돌이 없어요.'
    foreach ($s in $script:Session.skipped) { Write-Info "  건너뜀: $($s.path) ($($s.reason))" }
    exit 0
  }
  Write-Info "충돌 DataTable $($script:Session.files.Count)개: $(( $script:Session.files | ForEach-Object { $_.path }) -join ', ')"
  foreach ($s in $script:Session.skipped) { Write-Info "  건너뜀: $($s.path) ($($s.reason))" }
}

$listener = New-Object Net.HttpListener
$prefix = "http://localhost:$Port/"
$listener.Prefixes.Add($prefix)
try { $listener.Start() } catch { Write-Info "포트 $Port 를 열 수 없어요. -Port 로 다른 번호를 지정해 보세요."; exit 1 }
Write-Info "병합 화면: $prefix  (끝내려면 화면의 '완료' 또는 Ctrl+C)"
if (-not $NoBrowser) { Start-Process $prefix | Out-Null }

$running = $true
try {
  while ($running -and $listener.IsListening) {
    $ctx = $listener.GetContext()
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
    Write-Info '모든 DataTable 충돌을 해결했어요. 남은 충돌이 없으면 git commit 으로 머지를 마치세요.'
  } else {
    Write-Info "아직 해결 안 된 파일: $(($left | ForEach-Object { $_.path }) -join ', ')"
  }
}
