param([string]$Listen = '0.0.0.0:9443', [string]$Data = '.data')
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $workspace
if (-not (Test-Path -LiteralPath 'artifacts/build/panestra-core.exe')) { & "$PSScriptRoot/build.ps1" }
& './artifacts/build/panestra-core.exe' --data $Data --listen $Listen --plugin-seed artifacts/build/plugin-seed --headless
