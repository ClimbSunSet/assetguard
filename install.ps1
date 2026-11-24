<#
  `git assetguard` 명령을 등록합니다 (Git 전역 설정에 별칭 1줄 추가).
  사용:  powershell -ExecutionPolicy Bypass -File install.ps1
  제거:  git config --global --unset alias.assetguard
#>
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$script = (Join-Path $PSScriptRoot 'assetguard.ps1') -replace '\\', '/'
# Git 별칭의 '!' 명령은 저장소 최상위 폴더에서 실행되므로 -Repo . 이면 됩니다.
$alias = "!powershell.exe -NoProfile -ExecutionPolicy Bypass -File '$script' -Repo ."
git config --global alias.assetguard $alias
Write-Host "[AssetGuard] 등록 완료. 머지 충돌이 나면 저장소 안에서 'git assetguard' 를 실행하세요."
Write-Host "             (별칭 내용: $alias)"
