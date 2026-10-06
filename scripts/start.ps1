param([string]$Listen = '0.0.0.0:9443', [string]$Data = '.data')
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $workspace
if (-not (Test-Path -LiteralPath 'artifacts/panestra-core.exe')) { & "$PSScriptRoot/build.ps1" }
& './artifacts/panestra-core.exe' --data $Data --listen $Listen --worker artifacts/system-plugin.exe --manifest plugins/system/manifest.json --headless
