<#
  검증용 프로젝트(make-spike-project.ps1 로 만든 것)에 실제 .uasset DataTable 머지 충돌을 만듭니다.

    main            : DT_Tags 의 Fire·Wind 설명 수정, Earth 행 추가 / DT_BPStruct Row_A 변경
    feature/theirs  : DT_Tags 의 Ice·Wind 설명 수정, Thunder 행 추가 / DT_BPStruct Row_C 추가
  -> Wind 설명만 진짜 충돌, 나머지는 자동 병합 대상. Git 은 두 .uasset 모두 통째로 충돌로 처리합니다.

  사용: powershell -ExecutionPolicy Bypass -File ue\make-uasset-conflict.ps1 -Engine E:\UE_5.8 [-Path D:\AssetGuardSpike]
  그다음: powershell -ExecutionPolicy Bypass -File assetguard.ps1 -Repo D:\AssetGuardSpike
#>
param(
  [Parameter(Mandatory = $true)][string]$Engine,
  [string]$Path = 'D:\AssetGuardSpike'
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$cmd = Join-Path $Engine 'Engine\Binaries\Win64\UnrealEditor-Cmd.exe'
$uproject = Join-Path $Path 'AssetGuardSpike.uproject'
if (-not (Test-Path (Join-Path $Path '.assetguard-spike'))) { throw "$Path 는 검증용 프로젝트가 아니에요. 먼저 make-spike-project.ps1 을 실행하세요." }
$here = $PSScriptRoot -replace '\\', '/'

function Invoke-SpikeGit { & git.exe -C $Path -c user.name=spike -c user.email=spike@local @args; if ($LASTEXITCODE -ne 0) { throw "git $args 실패" } }
# For commands that are allowed to fail (nothing to abort, branch not there yet). In PS 5.1,
# `2>$null` on a native command still throws under ErrorActionPreference=Stop, so relax it here.
function Invoke-GitQuiet { $ErrorActionPreference = 'Continue'; & git.exe -C $Path @args 2>&1 | Out-Null }
function Invoke-Ue([string]$mode) {
  $log = Join-Path $Path "spike-conflict-$mode.log"
  $argLine = "`"$uproject`" -run=pythonscript -script=`"$here/make_spike_assets.py $mode`" -unattended -nosplash -nullrhi -nop4 -stdout -FullStdOutLogOutput"
  Write-Host "[spike] 언리얼로 '$mode' 버전 만드는 중..."
  $p = Start-Process -FilePath $cmd -ArgumentList $argLine -NoNewWindow -Wait -PassThru -RedirectStandardOutput $log
  if ($p.ExitCode -ne 0) { throw "언리얼 실행 실패 (종료 코드 $($p.ExitCode)). 로그: $log" }
}

# Start from a clean main at the v2 commit made by make-spike-project.ps1.
Invoke-GitQuiet merge --abort
Invoke-SpikeGit checkout -q -f main
Invoke-SpikeGit reset -q --hard (& git.exe -C $Path log --format=%H --grep='^v2 ' -n 1 main)
Invoke-SpikeGit clean -q -fd Content
Invoke-GitQuiet branch -D feature/theirs

Invoke-SpikeGit switch -q -c feature/theirs
Invoke-Ue 'theirs'
Invoke-SpikeGit add -A Content; Invoke-SpikeGit commit -q -m '기획: Ice·Wind 설명 수정, Thunder 추가, Row_C 추가'
Invoke-SpikeGit switch -q main
Invoke-Ue 'mine'
Invoke-SpikeGit add -A Content; Invoke-SpikeGit commit -q -m '나: Fire·Wind 설명 수정, Earth 추가, Row_A 변경'

$ErrorActionPreference = 'Continue'   # the merge is expected to fail with conflicts
& git.exe -C $Path -c user.name=spike -c user.email=spike@local merge feature/theirs 2>&1 | ForEach-Object { "  $_" }
& git.exe -C $Path status --short
Write-Host ''
Write-Host "[spike] 충돌 준비 완료. 병합 화면 열기:"
Write-Host "  powershell -ExecutionPolicy Bypass -File `"$((Split-Path $PSScriptRoot) -replace '/', '\')\assetguard.ps1`" -Repo `"$Path`" -Engine `"$Engine`""
