@echo off
rem AssetGuard launcher: runs assetguard.ps1 next to this file and passes all arguments through.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0assetguard.ps1" %*
