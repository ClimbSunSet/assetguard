<#
  검증용 언리얼 프로젝트를 새로 만들고(팀 프로젝트는 건드리지 않음), 테스트 DataTable 을
  두 버전으로 커밋한 뒤 spike_datatable.py 를 화면 없이 실행합니다.

  사용: powershell -ExecutionPolicy Bypass -File ue\make-spike-project.ps1 -Engine E:\UE_5.8 [-Path D:\AssetGuardSpike]
  결과: <Path>\Saved\AssetGuard\spike_report.json, 로그는 <Path>\spike-*.log
#>
param(
  [Parameter(Mandatory = $true)][string]$Engine,
  [string]$Path = 'D:\AssetGuardSpike',
  [switch]$SkipCreate
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$cmd = Join-Path $Engine 'Engine\Binaries\Win64\UnrealEditor-Cmd.exe'
if (-not (Test-Path $cmd)) { throw "UnrealEditor-Cmd.exe 를 찾을 수 없어요: $cmd" }
$here = $PSScriptRoot -replace '\\', '/'
$uproject = Join-Path $Path 'AssetGuardSpike.uproject'
$utf8 = New-Object Text.UTF8Encoding $false

function Invoke-Ue([string]$script, [string]$logName) {
  $log = Join-Path $Path $logName
  $argLine = "`"$uproject`" -run=pythonscript -script=`"$script`" -unattended -nosplash -nullrhi -nop4 -stdout -FullStdOutLogOutput"
  Write-Host "[spike] 실행: $script"
  $p = Start-Process -FilePath $cmd -ArgumentList $argLine -NoNewWindow -Wait -PassThru -RedirectStandardOutput $log
  Write-Host "[spike] 종료 코드 $($p.ExitCode), 로그 $log"
  return $log
}
function Invoke-SpikeGit { & git.exe -C $Path -c user.name=spike -c user.email=spike@local @args; if ($LASTEXITCODE -ne 0) { throw "git $args 실패" } }

if (-not $SkipCreate) {
  if (Test-Path $Path) {
    if (-not (Test-Path (Join-Path $Path '.assetguard-spike'))) { throw "$Path 가 이미 있고 검증용 폴더가 아니에요." }
    Remove-Item -Recurse -Force $Path
  }
  New-Item -ItemType Directory -Force (Join-Path $Path 'Content') | Out-Null
  [IO.File]::WriteAllText((Join-Path $Path '.assetguard-spike'), 'spike', $utf8)
  $assoc = (Split-Path $Engine -Leaf) -replace '^UE_', ''
  [IO.File]::WriteAllText($uproject, @"
{
  "FileVersion": 3,
  "EngineAssociation": "$assoc",
  "Category": "",
  "Description": "AssetGuard UE spike",
  "Plugins": [
    { "Name": "PythonScriptPlugin", "Enabled": true },
    { "Name": "EditorScriptingUtilities", "Enabled": true }
  ]
}
"@, $utf8)
  [IO.File]::WriteAllText((Join-Path $Path '.gitignore'), "Saved/`nIntermediate/`nDerivedDataCache/`nBinaries/`n*.log`n.assetguard-spike`n", $utf8)

  Invoke-SpikeGit init -q -b main
  Invoke-SpikeGit lfs install --local | Out-Null
  Invoke-SpikeGit lfs track '*.uasset' '*.umap' | Out-Null

  Invoke-Ue "$here/make_spike_assets.py v1" 'spike-setup-v1.log' | Out-Null
  Invoke-SpikeGit add -A; Invoke-SpikeGit commit -q -m 'v1 테스트 데이터'
  Invoke-Ue "$here/make_spike_assets.py v2" 'spike-setup-v2.log' | Out-Null
  Invoke-SpikeGit add -A; Invoke-SpikeGit commit -q -m 'v2 값 수정 + 행 추가'
}

$a = Invoke-Ue "$here/spike_datatable.py /Game/Data/DT_Tags /Game/Data/DT_BPStruct --rev=HEAD" 'spike-run-head.log'
Copy-Item (Join-Path $Path 'Saved\AssetGuard\spike_report.json') (Join-Path $Path 'spike_report_head.json') -ErrorAction SilentlyContinue
$b = Invoke-Ue "$here/spike_datatable.py /Game/Data/DT_Tags /Game/Data/DT_BPStruct --rev=HEAD~1" 'spike-run-prev.log'
Copy-Item (Join-Path $Path 'Saved\AssetGuard\spike_report.json') (Join-Path $Path 'spike_report_prev.json') -ErrorAction SilentlyContinue
Write-Host "[spike] 끝. 보고서: $Path\spike_report_head.json, $Path\spike_report_prev.json"
