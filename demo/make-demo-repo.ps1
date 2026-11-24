<#
  데모용 Git 저장소를 만들고 DataTable 머지 충돌을 실제로 일으킵니다.
  사용:  powershell -ExecutionPolicy Bypass -File demo\make-demo-repo.ps1 [-Path C:\temp\assetguard-demo]
  그다음: powershell -ExecutionPolicy Bypass -File assetguard.ps1 -Repo <Path>
#>
param([string]$Path = (Join-Path $env:TEMP 'assetguard-demo'))
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$Utf8NoBom = New-Object Text.UTF8Encoding $false

if (Test-Path $Path) {
  if (-not (Test-Path (Join-Path $Path '.assetguard-demo'))) { throw "$Path 가 이미 있고 데모 폴더가 아니에요. 다른 -Path 를 지정하세요." }
  Remove-Item -Recurse -Force $Path
}
New-Item -ItemType Directory -Force (Join-Path $Path 'Content\Data') | Out-Null
Set-Content -Path (Join-Path $Path '.assetguard-demo') -Value 'demo'

function Write-Demo($rel, $text) { [IO.File]::WriteAllText((Join-Path $Path $rel), ($text -replace "`r?`n", "`r`n"), $Utf8NoBom) }
function Invoke-DemoGit { & git -C $Path @args 2>&1 | Out-Null; if ($LASTEXITCODE -gt 1) { throw "git $args 실패" } }
function Save-DemoCommit($who, $msg) { & git -C $Path -c "user.name=$who" -c "user.email=$who@demo.local" commit -q -m $msg 2>&1 | Out-Null }

Invoke-DemoGit init -q -b main
Set-Content -Path (Join-Path $Path '.gitignore') -Value '.assetguard-demo'

# ---- 공통 원본 ----
Write-Demo 'Content\Data\DT_Monsters.json' @'
[
	{ "Name": "Goblin", "HP": 100, "Speed": 3.5, "Reward": 10, "Mesh": "/Game/Monsters/SK_Goblin" },
	{ "Name": "Orc", "HP": 250, "Speed": 2.0, "Reward": 30, "Mesh": "/Game/Monsters/SK_Orc" },
	{ "Name": "Wolf", "HP": 80, "Speed": 6.0, "Reward": 12, "Mesh": "/Game/Monsters/SK_Wolf" },
	{ "Name": "Bat", "HP": 30, "Speed": 7.0, "Reward": 3, "Mesh": "/Game/Monsters/SK_Bat" }
]
'@
Write-Demo 'Content\Data\DT_Vehicles.csv' @'
---,MaxSpeed,Mass,Color
Sedan,"120","1300","White"
Truck,"90","5000","Blue"
Bus,"80","9000","Yellow"
'@
Invoke-DemoGit add -A; Save-DemoCommit '팀장' '데이터테이블 초안'

# ---- 기획자 브랜치 ----
Invoke-DemoGit switch -q -c feature/new-monsters
Write-Demo 'Content\Data\DT_Monsters.json' @'
[
	{ "Name": "Goblin", "HP": 100, "Speed": 3.5, "Reward": 15, "Mesh": "/Game/Monsters/SK_Goblin" },
	{ "Name": "Orc", "HP": 300, "Speed": 2.0, "Reward": 40, "Mesh": "/Game/Monsters/SK_Orc" },
	{ "Name": "Wolf", "HP": 80, "Speed": 6.0, "Reward": 12, "Mesh": "/Game/Monsters/SK_Wolf" },
	{ "Name": "Slime", "HP": 40, "Speed": 1.0, "Reward": 5, "Mesh": "/Game/Monsters/SK_Slime" }
]
'@
Write-Demo 'Content\Data\DT_Vehicles.csv' @'
---,MaxSpeed,Mass,Color
Sedan,"120","1300","White"
Truck,"90","5000","Blue"
Bus,"80","9000","Yellow"
Taxi,"110","1350","Orange"
'@
Invoke-DemoGit add -A; Save-DemoCommit '기획자' '슬라임·택시 추가, 오크 체력·보상 조정, 박쥐 삭제'

# ---- 내 브랜치 (main) ----
Invoke-DemoGit switch -q main
Write-Demo 'Content\Data\DT_Monsters.json' @'
[
	{ "Name": "Goblin", "HP": 120, "Speed": 3.5, "Reward": 10, "Mesh": "/Game/Monsters/SK_Goblin" },
	{ "Name": "Orc", "HP": 280, "Speed": 2.4, "Reward": 30, "Mesh": "/Game/Monsters/SK_Orc" },
	{ "Name": "Wolf", "HP": 80, "Speed": 6.0, "Reward": 12, "Mesh": "/Game/Monsters/SK_Wolf" },
	{ "Name": "Bat", "HP": 30, "Speed": 7.0, "Reward": 3, "Mesh": "/Game/Monsters/SK_Bat" },
	{ "Name": "Troll", "HP": 600, "Speed": 1.5, "Reward": 80, "Mesh": "/Game/Monsters/SK_Troll" }
]
'@
Write-Demo 'Content\Data\DT_Vehicles.csv' @'
---,MaxSpeed,Mass,Color
Sedan,"130","1300","White"
Truck,"90","5200","Blue"
Bus,"80","9000","Yellow"
Ambulance,"140","3000","White"
'@
Invoke-DemoGit add -A; Save-DemoCommit '나' '고블린 체력·오크 속도 밸런스, 트럭 무게 조정, 구급차 추가'

# ---- 머지 → 충돌 ----
& git -C $Path merge feature/new-monsters 2>&1 | ForEach-Object { "  $_" }
Write-Host ''
Write-Host "데모 저장소: $Path"
Write-Host "다음 명령으로 병합 화면을 여세요:"
Write-Host "  powershell -ExecutionPolicy Bypass -File `"$(Join-Path (Split-Path $PSScriptRoot) 'assetguard.ps1')`" -Repo `"$Path`""
